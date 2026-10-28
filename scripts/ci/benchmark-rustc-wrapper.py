#!/usr/bin/env python3
"""Experiment-only rustc wrapper: observe phases, gate Core metadata, vary library codegen."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def option(args, name):
    for i, arg in enumerate(args):
        if arg == name and i + 1 < len(args):
            return args[i + 1]
    return None


def native_codegen(args):
    """Keep embedded bitcode and final ThinLTO; replace bitcode-only library output."""
    result = []
    for arg in args:
        # Cargo emits these as '-C', 'key=value'. Leave the -C token in place.
        if arg == 'linker-plugin-lto' or arg.startswith('linker-plugin-lto='):
            arg = 'linker-plugin-lto=no'
        elif arg.startswith('embed-bitcode='):
            arg = 'embed-bitcode=yes'
        result.append(arg)
    if not any(arg.startswith('embed-bitcode=') for arg in result):
        result += ['-C', 'embed-bitcode=yes']
    return result


def metadata_notice(line):
    try:
        data = json.loads(line)
        return isinstance(data, dict) and data.get('emit') == 'metadata' and 'artifact' in data
    except (ValueError, UnicodeDecodeError):
        return False


def main():
    compiler, *original = sys.argv[1:]
    crate = option(original, '--crate-name')
    # Cargo's capability/version probes must remain transparent.
    if not crate:
        os.execv(compiler, [compiler, *original])
    folder = Path(os.environ['OPENBITFUN_BENCH_WRAPPER_LOG'])
    folder.mkdir(parents=True, exist_ok=True)
    log = folder / f'{os.getpid()}.json'
    gate = os.environ.get('OPENBITFUN_BENCH_SERIAL_CORE') == '1' and crate == 'openbitfun_core'
    native = (os.environ.get('OPENBITFUN_BENCH_NATIVE_LIBS') == '1'
              and '--target' in original
              and any(arg == 'linker-plugin-lto' or arg.startswith('linker-plugin-lto=') for arg in original))
    args = native_codegen(original) if native else original
    record = {'crate': crate, 'wrapper_pid': os.getpid(), 'original_args': original,
              'actual_args': args, 'serial_core': gate, 'native_codegen': native,
              'start_epoch': time.time(), 'start_monotonic': time.monotonic(), 'metadata': []}
    # Keep Cargo's jobserver descriptors open: dropping them changes concurrency.
    process = subprocess.Popen([compiler, *args], stderr=subprocess.PIPE, close_fds=False)
    record['rustc_pid'] = process.pid
    log.write_text(json.dumps(record))
    def forward(signum, _frame):
        try:
            process.send_signal(signum)
        except ProcessLookupError:
            pass
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    held = []
    for line in process.stderr:
        if metadata_notice(line):
            record['metadata'].append({'epoch': time.time(), 'monotonic': time.monotonic(), 'deferred': gate})
            log.write_text(json.dumps(record))
            if gate:
                held.append(line)
                continue
        sys.stderr.buffer.write(line)
        sys.stderr.buffer.flush()
    _, status, usage = os.wait4(process.pid, 0)
    process.returncode = os.waitstatus_to_exitcode(status)
    record.update(end_epoch=time.time(), end_monotonic=time.monotonic(), exit_code=process.returncode,
                  user_seconds=usage.ru_utime, system_seconds=usage.ru_stime,
                  max_rss_bytes=usage.ru_maxrss if sys.platform == 'darwin' else usage.ru_maxrss * 1024,
                  major_faults=usage.ru_majflt, minor_faults=usage.ru_minflt,
                  voluntary_switches=usage.ru_nvcsw, involuntary_switches=usage.ru_nivcsw)
    # The genuine metadata timestamp above remains available independently of
    # Cargo timings, whose frontend boundary is deliberately delayed in this arm.
    for line in held:
        sys.stderr.buffer.write(line)
    sys.stderr.buffer.flush()
    record['metadata_release_epoch'] = time.time() if held else None
    log.write_text(json.dumps(record, indent=2))
    return process.returncode if process.returncode >= 0 else 128 - process.returncode


if __name__ == '__main__':
    sys.exit(main())
