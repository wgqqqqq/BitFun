import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

wrapper = module('wrapper', 'benchmark-rustc-wrapper.py')
resources = module('resources', 'benchmark-resources.py')
benchmark = module('benchmark', 'benchmark-desktop-build.py')


class Controls(unittest.TestCase):
    def test_native_control_preserves_optimization_and_final_lto(self):
        original = ['--crate-name', 'openbitfun_core', '--target', 'aarch64-apple-darwin',
                    '-C', 'opt-level=3', '-C', 'linker-plugin-lto', '-C', 'codegen-units=1', '-C', 'strip=symbols']
        changed = wrapper.native_codegen(original)
        self.assertIn('linker-plugin-lto=no', changed)
        self.assertIn('embed-bitcode=yes', changed)
        for flag in ['opt-level=3', 'codegen-units=1', 'strip=symbols']:
            self.assertIn(flag, changed)
        for variant in ['rlib-serial', 'rlib-native', 'rlib-native-serial']:
            self.assertEqual(benchmark.build_command('aarch64-apple-darwin', 'rlib', 3),
                             benchmark.build_command('aarch64-apple-darwin', variant, 3))

    def test_metadata_detection_does_not_swallow_diagnostics(self):
        self.assertTrue(wrapper.metadata_notice(b'{"artifact":"out.rmeta","emit":"metadata"}\n'))
        for line in [b'{"message":"warning"}', b'{"artifact":"out.rlib","emit":"link"}', b'non-JSON diagnostic']:
            self.assertFalse(wrapper.metadata_notice(line))

    def test_vm_stat_parser_preserves_raw_page_counters(self):
        text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 123.\nSwapins: 45.\nSwapouts: 67.\n'
        self.assertEqual(resources.vm_stat_fields(text), {'page_size_bytes': 16384, 'Pages occupied by compressor': 123, 'Swapins': 45, 'Swapouts': 67})

    @unittest.skipIf(os.name == 'nt', 'Causal wrapper is POSIX only')
    def test_gate_delays_only_core_metadata_and_keeps_jobserver_fd(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            compiler = root / 'compiler.py'
            compiler.write_text('''#!/usr/bin/env python3
import json,os,sys,time
os.fstat(int(os.environ['TEST_INHERITED_FD']))
print(json.dumps({'artifact':'fixture.rmeta','emit':'metadata'}), file=sys.stderr, flush=True)
print('diagnostic-before-exit', file=sys.stderr, flush=True)
time.sleep(.15)
print('compiler-finishing', file=sys.stderr, flush=True)
''')
            compiler.chmod(0o755)
            fd = os.open(root/'jobserver', os.O_CREAT | os.O_RDWR, 0o600)
            os.set_inheritable(fd, True)
            try:
                for crate, gate in [('openbitfun_core', True), ('openbitfun_desktop_lib', False)]:
                    out = root / crate
                    env = dict(os.environ, OPENBITFUN_BENCH_WRAPPER_LOG=str(out), OPENBITFUN_BENCH_SERIAL_CORE='1', TEST_INHERITED_FD=str(fd))
                    run = subprocess.run([sys.executable, str(ROOT/'scripts/ci/benchmark-rustc-wrapper.py'), str(compiler), '--crate-name', crate], capture_output=True, text=True, env=env, pass_fds=(fd,))
                    self.assertEqual(run.returncode, 0, run.stderr)
                    records = list(out.glob('*.json'))
                    record = json.loads(records[0].read_text())
                    self.assertEqual(record['metadata'][0]['deferred'], gate)
                    self.assertLess(record['metadata'][0]['epoch'], record['end_epoch'])
                    self.assertEqual(record['exit_code'], 0)
                    self.assertIn('user_seconds', record)
                    if gate:
                        self.assertGreater(run.stderr.index('fixture.rmeta'), run.stderr.index('compiler-finishing'))
                    else:
                        self.assertLess(run.stderr.index('fixture.rmeta'), run.stderr.index('compiler-finishing'))
            finally:
                os.close(fd)

    @unittest.skipIf(os.name == 'nt', 'Causal wrapper is POSIX only')
    def test_wrapper_keeps_failure_status_and_diagnostics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            compiler = root/'compiler.py'
            compiler.write_text('#!/usr/bin/env python3\nimport sys\nprint("fixture compiler error",file=sys.stderr)\nsys.exit(37)\n')
            compiler.chmod(0o755)
            env = dict(os.environ, OPENBITFUN_BENCH_WRAPPER_LOG=str(root/'logs'))
            run = subprocess.run([sys.executable, str(ROOT/'scripts/ci/benchmark-rustc-wrapper.py'), str(compiler), '--crate-name', 'fixture'], capture_output=True, text=True, env=env)
            self.assertEqual(run.returncode, 37)
            self.assertIn('fixture compiler error', run.stderr)


if __name__ == '__main__':
    unittest.main()
