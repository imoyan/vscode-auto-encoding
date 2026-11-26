"""Synthetic-only regression checks; no real credentials or external CI."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('check', Path(__file__).with_name('check_gitleaks.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'repo'
        self.root.mkdir()
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'Test', 'GIT_COMMITTER_NAME': 'Test',
                    'GIT_AUTHOR_EMAIL': 'test@example.invalid', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
        self.git('init', '-q')
        self.commit('README.md', 'API_TOKEN is read from the environment.\n')
        self.binary = Path(self.tmp.name) / 'fake-gitleaks'

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.root, env=self.env,
                                       stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, name, text):
        (self.root / name).write_text(text)
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic test')

    def fake(self, status=0, report='[]', version='8.30.1'):
        self.binary.write_text(f'#!{sys.executable}\nimport sys,pathlib\n'
          f'if sys.argv[1]=="version": print({version!r}); sys.exit(0)\n'
          'assert "--ignore-gitleaks-allow" in sys.argv\n'
          'assert "--redact=100" in sys.argv\n'
          'assert pathlib.Path(sys.argv[2]).name=="history.git"\n'
          'assert not pathlib.Path(sys.argv[2],".gitleaksignore").exists()\n'
          f'pathlib.Path(next(x.split("=",1)[1] for x in sys.argv if x.startswith("--report-path="))).write_text({report!r})\n'
          'print("SYNTHETIC_RAW_MARKER",file=sys.stderr)\n'
          f'sys.exit({status})\n')
        self.binary.chmod(0o700)

    def run_scan(self, expected=None, root=None, binary=None):
        with tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
            return check.scan(root or self.root, expected or self.git('rev-parse', 'HEAD'),
                              binary or self.binary, Path(directory))

    def test_clean_and_output_redaction(self):
        self.fake()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.run_scan(), 0)
        self.assertNotIn('SYNTHETIC_RAW_MARKER', out.getvalue())
        self.assertIn('findings=0', out.getvalue())

    def test_findings_fail_without_output(self):
        self.fake(23, '[{"Secret":"SYNTHETIC_RAW_MARKER"}]')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.run_scan(), 1)
        self.assertNotIn('SYNTHETIC_RAW_MARKER', out.getvalue())

    def test_tool_error_invalid_report_and_inconsistent_result(self):
        for status, report in [(1, '[]'), (0, '{}'), (0, 'not-json'), (0, '[{}]'), (23, '[]')]:
            with self.subTest(status=status, report=report):
                self.fake(status, report)
                with self.assertRaises((RuntimeError, ValueError)):
                    self.run_scan()

    def test_wrong_sha_and_version(self):
        self.fake()
        with self.assertRaises(RuntimeError):
            self.run_scan('0' * 40)
        self.fake(version='0.0.0')
        with self.assertRaises(RuntimeError):
            self.run_scan()

    def test_shallow_history_rejected(self):
        shallow = Path(self.tmp.name) / 'shallow'
        subprocess.run(['git', 'clone', '-q', '--depth=1', self.root.as_uri(), str(shallow)], check=True)
        self.fake()
        with self.assertRaises(RuntimeError):
            self.run_scan(root=shallow)

    def test_repo_ignore_does_not_enter_snapshot(self):
        self.commit('.gitleaksignore', '*\n')
        self.fake()
        self.assertEqual(self.run_scan(), 0)

    def test_credentials_and_config_not_inherited(self):
        self.assertEqual(set(check.safe_env('/tmp/home')), {
            'PATH', 'HOME', 'LC_ALL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
            'GIT_TERMINAL_PROMPT', 'GIT_NO_REPLACE_OBJECTS'})

    def test_download_mismatch_fails_before_extraction(self):
        with tempfile.TemporaryDirectory(dir=self.tmp.name) as directory:
            with patch.object(check.platform, 'system', return_value='Linux'), \
                 patch.object(check.platform, 'machine', return_value='x86_64'), \
                 patch.object(check.urllib.request, 'urlopen', return_value=io.BytesIO(b'not an official archive')):
                with self.assertRaises(RuntimeError):
                    check.install(Path(directory))
                self.assertFalse((Path(directory) / 'gitleaks').exists())

    def test_timeout_and_missing_report_are_not_success(self):
        self.fake()
        with patch.object(check, 'command', side_effect=subprocess.TimeoutExpired('synthetic', 1)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.run_scan()
        self.binary.write_text('#!/bin/sh\nif [ "$1" = version ]; then echo 8.30.1; fi\nexit 0\n')
        with self.assertRaises(RuntimeError):
            self.run_scan()

    def test_only_linux_verify_runs_the_scanner(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
        linux, rest = workflow.split('  extension-host:', 1)
        self.assertEqual(linux.count('run: python3 tools/check_gitleaks.py'), 1)
        self.assertIn('fetch-depth: 0', linux)
        self.assertNotIn('check_gitleaks', rest)

    @unittest.skipUnless(os.environ.get('GITLEAKS_TEST_BINARY'), 'optional real pinned CLI smoke')
    def test_real_clean_and_deleted_history_secret(self):
        binary = Path(os.environ['GITLEAKS_TEST_BINARY']).resolve()
        self.assertEqual(self.run_scan(binary=binary), 0)
        # Generated, synthetic shape only; never a real credential.
        token = 'ghp_' + 'Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6'
        self.commit('synthetic.txt', token + '\n')
        (self.root / 'synthetic.txt').unlink()
        self.git('add', '-A')
        self.git('commit', '-qm', 'remove synthetic fixture')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(self.run_scan(binary=binary), 1)
        self.assertNotIn(token, out.getvalue())


if __name__ == '__main__':
    unittest.main()
