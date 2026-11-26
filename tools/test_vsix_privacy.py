import contextlib
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile
from check_vsix_privacy import scan

class GuardTests(unittest.TestCase):
    def fixture(self, content, name="extension/dist/extension.js"):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = pathlib.Path(directory.name) / "fixture.vsix"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(name, content)
        return path

    def test_clean_public_metadata(self):
        self.assertEqual(scan(self.fixture(b'{"publisher":"synthetic-public","repository":"https://github.com/example/example","sample":"localhost 127.0.0.1 /usr/lib/library"}')), {})

    def test_platform_paths(self):
        for content, category in [
            (b"/Users/synthetic-person/project/source.ts", "mac_home_path"),
            (b"/home/synthetic-person/project/source.ts", "linux_home_path"),
            (b"C:\\Users\\synthetic-person\\project", "windows_home_path"),
            (b"C:/Users/synthetic-person/project", "windows_home_path"),
            (b'C:\\\\Users\\\\synthetic-person\\\\project', "windows_home_path"),
        ]:
            with self.subTest(category=category):
                self.assertIn(category, scan(self.fixture(content)))

    def test_utf16_windows_path(self):
        self.assertIn("windows_home_path", scan(self.fixture("C:\\Users\\synthetic-person\\project".encode("utf-16-le"))))

    def test_unicode_unix_paths_and_normalization(self):
        for path, category in [
            ("/Users/合成ユーザー/project", "mac_home_path"),
            ("/home/合成ユーザー/project", "linux_home_path"),
            ("/Users/synthe\u0301tique/project", "mac_home_path"),
        ]:
            with self.subTest(category=category):
                self.assertEqual(scan(self.fixture(path.encode())), {category: 1})
                self.assertEqual(scan(self.fixture(b"", path)), {category: 1})

    def test_quoted_unix_home_directories_without_trailing_slash(self):
        for path, category in [
            ("/Users/合成 ユーザー", "mac_home_path"),
            ("/home/synthetic-user", "linux_home_path"),
        ]:
            with self.subTest(category=category, context="JSON"):
                content = json.dumps({"home": path}, ensure_ascii=False).encode()
                self.assertEqual(scan(self.fixture(content)), {category: 1})
            for delimiter in ("'", '"', "`"):
                with self.subTest(category=category, delimiter=delimiter):
                    content = f"const home = {delimiter}{path}{delimiter};".encode()
                    self.assertEqual(scan(self.fixture(content)), {category: 1})

    def test_quoted_unix_paths_do_not_relax_username_or_prefix(self):
        for path in ("/Users/synthetic+user", "/home/synthetic+user",
                     "project/Users/synthetic-user", "https://example.invalid/home/synthetic-user"):
            with self.subTest(path=path):
                self.assertEqual(scan(self.fixture(json.dumps({"path": path}).encode())), {})

    def test_both_utf16_alignments_and_byteorders(self):
        for encoding in ("utf-16-le", "utf-16-be"):
            for prefix in (b"", b"\xff"):
                with self.subTest(encoding=encoding, prefix=prefix):
                    content = prefix + "/Users/合成ユーザー/project".encode(encoding)
                    self.assertEqual(scan(self.fixture(content)), {"mac_home_path": 1})

    def test_explicit_private_hostname(self):
        for host in (b"synthetic-machine.local", b"synthetic-machine.lan"):
            self.assertIn("private_hostname", scan(self.fixture(host)))

    def test_public_hostname_and_partial_suffix(self):
        self.assertEqual(scan(self.fixture(b"public.example.com machine.local.example.com package.locality")), {})

    def test_source_map(self):
        self.assertEqual(scan(self.fixture(b"{}", "extension/dist/extension.js.map")), {"source_map": 1})

    def test_member_name(self):
        self.assertIn("linux_home_path", scan(self.fixture(b"", "/home/synthetic-person/file")))

    def test_no_values_in_output(self):
        path = self.fixture(b"/Users/synthetic-person/private-document")
        result = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("check_vsix_privacy.py")), str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("synthetic-person", result.stdout + result.stderr)
        self.assertNotIn(str(path), result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["passed"])

    def test_invalid_archive_is_generic(self):
        result = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("check_vsix_privacy.py")), "/missing-synthetic-file"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout), {"error": "archive_unreadable"})
        self.assertNotIn("missing-synthetic", result.stdout + result.stderr)

if __name__ == "__main__":
    unittest.main()
