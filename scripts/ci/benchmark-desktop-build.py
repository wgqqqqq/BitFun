#!/usr/bin/env python3
"""Fork-only cold release experiments; never publishes product artifacts."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
VARIANTS = ("baseline", "rlib", "rlib-codegen16", "rlib-serial", "rlib-native", "rlib-native-serial", "rlib-jobs1")
CONTROLLED_VARIANTS = ("rlib-serial", "rlib-native", "rlib-native-serial", "rlib-jobs1")
resource_spec = importlib.util.spec_from_file_location("benchmark_resources", Path(__file__).with_name("benchmark-resources.py"))
resources = importlib.util.module_from_spec(resource_spec)
resource_spec.loader.exec_module(resources)


def wrapper_environment(variant, output):
    return {"RUSTC_WRAPPER": str(ROOT / "scripts/ci/benchmark-rustc-wrapper.py"),
            "OPENBITFUN_BENCH_WRAPPER_LOG": str(output / "rustc-invocations"),
            "OPENBITFUN_BENCH_SERIAL_CORE": "1" if variant in ("rlib-serial", "rlib-native-serial") else "0",
            "OPENBITFUN_BENCH_NATIVE_LIBS": "1" if variant in ("rlib-native", "rlib-native-serial") else "0"}

NATIVE_TARGETS = {
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-aarch64",
    "aarch64-apple-darwin": "osx-arm64",
    "x86_64-apple-darwin": "osx-x64",
    "x86_64-pc-windows-msvc": "win-x64",
}


def command_output(args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def cpu_details():
    if sys.platform == "linux":
        return Path("/proc/cpuinfo").read_text(encoding="utf-8")
    if sys.platform == "darwin":
        return command_output(["sysctl", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize"])
    return platform.processor()


def variant_manifest(original, variant):
    if variant not in VARIANTS:
        raise ValueError(f"Unknown variant: {variant}")
    types = '"staticlib", "cdylib", "rlib"' if variant == "baseline" else '"rlib"'
    result, count = re.subn(r'^crate-type = \[.*?\]$', f"crate-type = [{types}]", original, flags=re.M)
    if count != 1:
        raise ValueError("Expected exactly one desktop crate-type declaration")
    return result


def build_command(target, variant, jobs):
    args = ["cargo", "build", "--offline", "--locked", "--release",
            "--target", target, "-p", "openbitfun-desktop",
            "--bin", "openbitfun-desktop", "--features", "tauri/custom-protocol",
            "-j", str(jobs), "--timings", "--verbose"]
    if variant == "rlib-codegen16":
        for package in ["openbitfun-core", "openbitfun-desktop"]:
            args += ["--config", f"profile.release.package.{package}.codegen-units=16",
                     "--config", f"profile.release.package.{package}.strip=true"]
    return args


def prepare_native(target, destination):
    lock = tomllib.loads((ROOT / "Cargo.lock").read_text())
    versions = [p["version"] for p in lock["package"] if p["name"] == "sherpa-onnx-sys"]
    if len(versions) != 1:
        raise ValueError("Expected one locked sherpa-onnx-sys version")
    version = versions[0]
    suffix = "static-MT-Release-lib" if "windows" in target else "static-lib"
    name = f"sherpa-onnx-v{version}-{NATIVE_TARGETS[target]}-{suffix}.tar.bz2"
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / name
    url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/v{version}/{name}"
    # Prefetch before the clock; the exact archive digest is attached to each result.
    for attempt in range(3):
        try:
            urllib.request.urlretrieve(url, archive)
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2)
    with tarfile.open(archive) as tar:
        tar.extractall(destination, filter="data")
    lib = destination / name.removesuffix(".tar.bz2") / "lib"
    if not lib.is_dir():
        raise ValueError(f"Missing native library directory: {lib}")
    return lib, {"url": url, "sha256": file_hash(archive)}


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def collect_units(target_dir, output):
    timings = target_dir / "cargo-timings"
    if not timings.exists():
        return {}
    shutil.copytree(timings, output / "cargo-timings", dirs_exist_ok=True)
    report = timings / "cargo-timing.html"
    if not report.exists() or "const UNIT_DATA = " not in report.read_text():
        return {}
    units = json.JSONDecoder().raw_decode(report.read_text().split("const UNIT_DATA = ", 1)[1])[0]
    (output / "units.json").write_text(json.dumps(units, indent=2))
    fields = ["name", "version", "mode", "target", "features"]
    closure = sorted(json.dumps({k: u.get(k) for k in fields}, sort_keys=True) for u in units)
    (output / "unit-closure.json").write_text(json.dumps(closure, indent=2))
    return {"unit_count": len(units),
            "unit_closure_sha256": hashlib.sha256(json.dumps(closure).encode()).hexdigest(),
            "critical_units": [u for u in units if u["name"] in ["openbitfun-core", "openbitfun-desktop"]]}


def main():
    import psutil
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=VARIANTS, required=True)
    parser.add_argument("--target", choices=NATIVE_TARGETS, required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target-dir", required=True, type=Path)
    parser.add_argument("--jobs", type=int, default=os.cpu_count())
    parser.add_argument("--instrument", action="store_true", help="Use identical rustc wrapper and richer system sampling in every compared arm")
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "wgqqqqq/BitFun":
        parser.error("This experiment must run in the authorized fork's Actions runner")
    if args.target != "aarch64-apple-darwin" and (args.variant in CONTROLLED_VARIANTS or args.instrument):
        parser.error("Instrumented causal controls currently require macOS ARM64")
    if args.variant == "rlib-jobs1":
        args.jobs = 1
    if args.jobs < 1:
        parser.error("jobs must be positive")
    output = args.output.resolve()
    target_dir = args.target_dir.resolve()
    if target_dir.exists():
        parser.error("Cold target directory must not already exist")
    output.mkdir(parents=True, exist_ok=True)
    manifest = ROOT / "src/apps/desktop/Cargo.toml"
    original = manifest.read_text(encoding="utf-8")
    manifest.write_text(variant_manifest(original, args.variant))
    try:
        lib, native = prepare_native(args.target, output / "native")
        # Do not upload the large archive or libraries, only its provenance.
        native_dir = output.parent / (output.name + "-native")
        (output / "native").rename(native_dir)
        lib = native_dir / lib.relative_to(output / "native")
        env = dict(os.environ, CARGO_TARGET_DIR=str(target_dir), CARGO_INCREMENTAL="0",
                   CARGO_TERM_COLOR="never", OPENBITFUN_TARGET_GC="0", SHERPA_ONNX_LIB_DIR=str(lib))
        instrument = args.instrument or args.variant in CONTROLLED_VARIANTS
        if instrument:
            if any(os.getenv(k) for k in ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']):
                raise ValueError("Unexpected compiler wrapper or flags would confound the experiment")
            env.update(wrapper_environment(args.variant, output))
        args_command = build_command(args.target, args.variant, args.jobs)
        info = {"variant": args.variant, "target": args.target, "command": args_command,
                "source_sha": command_output(["git", "rev-parse", "HEAD"]),
                "rustc": command_output(["rustc", "-vV"]),
                "cargo_lock_sha256": file_hash(ROOT / "Cargo.lock"),
                "jobs": args.jobs, "platform": platform.platform(), "cpu": platform.processor(),
                "cpu_details": cpu_details(),
                "logical_cpus": psutil.cpu_count(), "physical_cpus": psutil.cpu_count(logical=False),
                "memory_bytes": psutil.virtual_memory().total, "native_archive": native,
                "runner": {k: os.getenv(k) for k in ["RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
                             "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]},
                "scope": "Cold Rust release build; excludes downloads, frontend, sidecar, bundle, signing and notarization",
                "memory_method": "500ms sampled process-tree RSS sum; shared pages may be counted more than once"}
        info.update(instrumented=instrument,
                    controls={"serial_core_metadata": env.get("OPENBITFUN_BENCH_SERIAL_CORE") == "1",
                              "native_library_codegen": env.get("OPENBITFUN_BENCH_NATIVE_LIBS") == "1"},
                    sampler_sha256=file_hash(ROOT / 'scripts/ci/benchmark-resources.py'),
                    wrapper_sha256=file_hash(ROOT / 'scripts/ci/benchmark-rustc-wrapper.py') if instrument else None)
        (output / "environment.json").write_text(json.dumps(info, indent=2))
        (output / "source.patch").write_text(command_output(["git", "diff", "--", "src/apps/desktop/Cargo.toml"]))
        (output / "desktop-manifest.toml").write_text(manifest.read_text())
        stopped = threading.Event()
        peaks = {"sampled_peak_tree_rss_bytes": 0, "sampled_peak_process_rss_bytes": 0}
        started = time.perf_counter()
        with (output / "build.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(args_command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            def sample():
                with (output / "memory.jsonl").open("w") as samples:
                    while not stopped.is_set():
                        rss = []
                        try:
                            parent = psutil.Process(process.pid)
                            for child in [parent] + parent.children(recursive=True):
                                try:
                                    rss.append(child.memory_info().rss)
                                except (psutil.NoSuchProcess, psutil.AccessDenied):
                                    pass
                        except (psutil.NoSuchProcess, psutil.AccessDenied):
                            pass
                        peaks["sampled_peak_tree_rss_bytes"] = max(peaks["sampled_peak_tree_rss_bytes"], sum(rss))
                        peaks["sampled_peak_process_rss_bytes"] = max([peaks["sampled_peak_process_rss_bytes"], *rss])
                        samples.write(json.dumps({"elapsed_s": time.perf_counter() - started, "tree_rss_bytes": sum(rss)}) + "\n")
                        stopped.wait(0.5)
            if instrument:
                monitor = threading.Thread(target=resources.monitor_resources,
                    args=(psutil, process.pid, output, stopped, started, peaks), daemon=True)
            else:
                monitor = threading.Thread(target=sample, daemon=True)
            monitor.start()
            while process.poll() is None:
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    print(f"{args.variant}: {time.perf_counter() - started:.0f}s elapsed; sampled tree peak {peaks['sampled_peak_tree_rss_bytes'] / 2**30:.2f} GiB", flush=True)
            elapsed = time.perf_counter() - started
            stopped.set()
            monitor.join()
        binary = target_dir / args.target / "release" / ("openbitfun-desktop.exe" if "windows" in args.target else "openbitfun-desktop")
        result = dict(info, exit_code=process.returncode, wall_seconds=elapsed, **peaks, **collect_units(target_dir, output))
        if binary.exists():
            result.update(binary_bytes=binary.stat().st_size, binary_sha256=file_hash(binary))
        if instrument:
            invocations = [json.loads(p.read_text()) for p in (output / 'rustc-invocations').glob('*.json')]
            main_units = [r for r in invocations if r['crate'] in ['openbitfun_core', 'openbitfun_desktop_lib', 'openbitfun_desktop'] and '--target' in r['actual_args']]
            if process.returncode == 0:
                if len(main_units) != 3 or any(r.get('exit_code') != 0 for r in main_units):
                    raise ValueError("Missing successful Core/Desktop wrapper observations")
                core = next(r for r in main_units if r['crate'] == 'openbitfun_core')
                desktop = next(r for r in main_units if r['crate'] == 'openbitfun_desktop_lib')
                if result['controls']['serial_core_metadata']:
                    if not any(m['deferred'] for m in core['metadata']) or desktop['start_epoch'] < core['end_epoch']:
                        raise ValueError("Core metadata barrier did not prevent Desktop overlap")
                result['core_desktop_overlap_seconds'] = max(0, min(core['end_epoch'], desktop['end_epoch']) - max(core['start_epoch'], desktop['start_epoch']))
                result['rustc_user_seconds'] = sum(r.get('user_seconds', 0) for r in invocations)
                result['rustc_system_seconds'] = sum(r.get('system_seconds', 0) for r in invocations)
                result['native_codegen_invocations'] = sum(r['native_codegen'] for r in invocations)
            (output / 'critical-invocations.json').write_text(json.dumps(main_units, indent=2))
            result['sampler_status'] = json.loads((output / 'sampler-status.json').read_text())
        (output / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2), flush=True)
        if process.returncode:
            print((output / "build.log").read_text(errors="replace")[-16000:], flush=True)
        if os.getenv("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"### {args.target} / {args.variant}\n\nCold Rust build: {elapsed / 60:.2f} min; exit {process.returncode}.\n\nDownloads, frontend, bundles and signing are outside this measurement.\n")
        return process.returncode
    finally:
        manifest.write_text(original)


if __name__ == "__main__":
    sys.exit(main())
