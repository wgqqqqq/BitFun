import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).with_name('benchmark-desktop-build.py'))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class BenchmarkContract(unittest.TestCase):
    def test_variant_changes_only_crate_types(self):
        original = '[lib]\ncrate-type = ["staticlib", "cdylib", "rlib"]\n[dependencies]\nfoo = "1"\n'
        self.assertEqual(benchmark.variant_manifest(original, 'baseline'), original)
        candidate = benchmark.variant_manifest(original, 'rlib')
        self.assertEqual(benchmark.variant_manifest(candidate, 'baseline'), original)
        self.assertEqual(benchmark.variant_manifest(original, 'rlib-codegen16'), candidate)

    def test_rejects_ambiguous_manifest_and_unknown_variant(self):
        for manifest in ['', 'crate-type = []\ncrate-type = []']:
            with self.assertRaises(ValueError):
                benchmark.variant_manifest(manifest, 'rlib')
        with self.assertRaises(ValueError):
            benchmark.variant_manifest('crate-type = []', 'invalid')

    def test_preserves_release_contract_and_strip_with_codegen_override(self):
        baseline = benchmark.build_command('aarch64-apple-darwin', 'baseline', 4)
        self.assertEqual(baseline, benchmark.build_command('aarch64-apple-darwin', 'rlib', 4))
        for flag in ['--locked', '--offline', '--release', '--timings']:
            self.assertIn(flag, baseline)
        candidate = benchmark.build_command('aarch64-apple-darwin', 'rlib-codegen16', 4)
        self.assertEqual(candidate[:len(baseline)], baseline)
        for package in ['openbitfun-core', 'openbitfun-desktop']:
            self.assertIn(f'profile.release.package.{package}.codegen-units=16', candidate)
            self.assertIn(f'profile.release.package.{package}.strip=true', candidate)
        self.assertNotIn('devtools', candidate)

    def test_missing_timings_are_not_fabricated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(benchmark.collect_units(root / 'target', root / 'output'), {})


if __name__ == '__main__':
    unittest.main()
