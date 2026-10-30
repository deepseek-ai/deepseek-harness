"""Development signing setup keeps one unlocked identity on the user keychain search list."""
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("dev_signing", Path(__file__).resolve().parents[1] / "dev_signing.py")
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class FakeSecurity:
    """Record security commands and model the user search list."""
    def __init__(self, keychains):
        self.keychains = list(keychains)
        self.commands = []

    def __call__(self, *args):
        self.commands.append(args)
        if args[:3] == ("list-keychains", "-d", "user") and len(args) == 3:
            return "".join(f'    "{path}"\n' for path in self.keychains)
        if args[:4] == ("list-keychains", "-d", "user", "-s"):
            self.keychains = list(args[4:])
        if args[0] == "delete-keychain":
            Path(args[1]).unlink()
        if args[0] == "find-identity":
            return "ABC123 NEW456"
        return ""


class DevelopmentSigningTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cua-dev-signing-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / "signing"
        self.keychain = self.directory / "signing.keychain-db"
        self.login = "/Users/example/Library/Keychains/login.keychain-db"

    def configure(self, listed=True):
        self.directory.mkdir()
        self.keychain.write_bytes(b"keychain")
        (self.directory / "identity.json").write_text(json.dumps({"sha1": "ABC123", "password": "secret"}))
        return self.fake([self.login, str(self.keychain)] if listed else [self.login])

    def fake(self, keychains):
        security = FakeSecurity(keychains)
        patcher = patch.object(signing, "security", security)
        patcher.start()
        self.addCleanup(patcher.stop)
        return security

    def test_signing_directory_follows_dsh_home_and_explicit_overrides(self):
        home = self.root / "user"
        with patch.object(Path, "home", return_value=home):
            for value in ("", "   "):
                with patch.dict(signing.os.environ, {"DSH_HOME": value}):
                    self.assertEqual(signing.default_directory(), home / ".dsh/computer-use-dev-signing")
            for value, expected in ((str(self.root / "custom"), self.root / "custom"),
                                    ("~/custom", home / "custom"), ("~", home),
                                    ("relative-home", Path(signing.os.path.abspath("relative-home")))):
                with patch.dict(signing.os.environ, {"DSH_HOME": value}):
                    self.assertEqual(signing.default_directory(), expected / "computer-use-dev-signing")
                    self.assertEqual(signing.default_directory(self.root / "explicit"),
                                     self.root / "explicit/computer-use-dev-signing")

    def test_setup_and_remove_commands_target_the_selected_dsh_home(self):
        directory = self.root / "home/computer-use-dev-signing"
        identity = signing.SigningIdentity("ABC123", directory / "signing.keychain-db")
        for action in ("setup", "remove"):
            with patch.object(signing.sys, "argv", ["dev_signing.py", action, "--dsh-home", str(directory.parent)]), \
                 patch.object(signing, action, return_value=identity) as operation, contextlib.redirect_stdout(io.StringIO()):
                signing.main()
            operation.assert_called_once_with(directory)

    def test_missing_setup_leaves_builds_unconfigured(self):
        self.fake([self.login])
        self.assertIsNone(signing.load(self.directory))

    def test_load_unlocks_the_keychain_before_returning_the_identity(self):
        security = self.configure()
        identity = signing.load(self.directory)
        self.assertEqual((identity.sha1, identity.keychain), ("ABC123", self.keychain))
        self.assertIn(("unlock-keychain", "-p", "secret", str(self.keychain)), security.commands)

    def test_listed_keychains_match_through_symbolic_links(self):
        (self.root / "alias").symlink_to(self.root, target_is_directory=True)
        self.configure()
        signing.security.keychains = [self.login, str(self.root / "alias/signing/signing.keychain-db")]
        self.assertEqual(signing.load(self.directory).sha1, "ABC123")

    def test_unlisted_or_missing_keychains_fail_with_the_setup_command(self):
        security = self.configure(listed=False)
        with self.assertRaisesRegex(RuntimeError, "search list; run pnpm"):
            signing.load(self.directory)
        self.keychain.unlink()
        with self.assertRaisesRegex(RuntimeError, "keychain is missing"):
            signing.load(self.directory)
        self.assertFalse(any(command[0] == "unlock-keychain" for command in security.commands))

    def test_setup_relists_an_existing_identity_without_creating_another(self):
        security = self.configure(listed=False)
        with patch.object(signing, "create_certificate") as create:
            self.assertEqual(signing.setup(self.directory).sha1, "ABC123")
        create.assert_not_called()
        self.assertEqual(security.keychains, [self.login, str(self.keychain)])

    def test_setup_replaces_an_incomplete_directory(self):
        security = self.configure()
        (self.directory / "identity.json").unlink()
        def create(directory, password):
            self.keychain.write_bytes(b"new keychain")
            return "NEW456"
        with patch.object(signing, "create_certificate", side_effect=create):
            identity = signing.setup(self.directory)
        self.assertEqual(identity.sha1, "NEW456")
        self.assertEqual(self.keychain.read_bytes(), b"new keychain")
        self.assertEqual(oct((self.directory / "identity.json").stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(self.directory.stat().st_mode & 0o777), "0o700")
        self.assertEqual(security.keychains, [self.login, str(self.keychain)])

    def test_setup_preserves_the_record_when_the_keychain_is_missing(self):
        security = self.configure()
        record = self.directory / "identity.json"
        before = record.read_bytes()
        self.keychain.unlink()
        with patch.object(signing, "create_certificate") as create:
            with self.assertRaisesRegex(RuntimeError, "keychain is missing: .*; run .*remove, then .*setup"):
                signing.setup(self.directory)
        create.assert_not_called()
        self.assertEqual(record.read_bytes(), before)
        self.assertFalse(self.keychain.exists())
        self.assertEqual(security.commands, [])

    def test_build_cli_stops_without_replacing_a_recorded_identity_missing_its_keychain(self):
        home = self.root / "home"
        directory = home / "computer-use-dev-signing"
        directory.mkdir(parents=True)
        record = directory / "identity.json"
        before = json.dumps({"sha1": "ABC123", "password": "secret-password"}).encode()
        record.write_bytes(before)
        output = self.root / "applications"
        script = """import runpy, sys
from pathlib import Path
from unittest.mock import patch
test_home = Path(sys.argv[2])
Path.home = lambda: test_home
sys.argv = [sys.argv[1], '--variant', 'dev', '--dsh-home', sys.argv[2], '--output-directory', sys.argv[3]]
with patch('subprocess.run', side_effect=AssertionError('unexpected native build or signing command')):
    runpy.run_path(sys.argv[0], run_name='__main__')
"""
        result = subprocess.run([sys.executable, "-c", script, str(Path(signing.__file__).with_name("build_app.py")), str(home), str(output)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertIn("keychain is missing", result.stderr)
        self.assertIn(f"run {signing.REMOVE_COMMAND} --dsh-home {home}, then {signing.SETUP_COMMAND} --dsh-home {home}", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("secret-password", result.stderr)
        self.assertEqual(record.read_bytes(), before)
        self.assertFalse(signing.keychain_path(directory).exists())
        self.assertFalse(output.exists())

    def test_remove_restores_the_other_search_list_entries_and_deletes_the_password(self):
        security = self.configure()
        signing.remove(self.directory)
        self.assertEqual(security.keychains, [self.login])
        self.assertFalse(self.directory.exists())
        signing.remove(self.directory)
        self.assertEqual(security.keychains, [self.login])

    def test_missing_certificate_requires_explicit_removal_instead_of_changing_identity(self):
        self.configure()
        (self.directory / "identity.json").write_text(json.dumps({"sha1": "MISSING", "password": "secret"}))
        with self.assertRaisesRegex(RuntimeError, "certificate is missing; run .*remove, then .*setup"):
            signing.setup(self.directory)
        self.assertTrue(self.keychain.is_file())

    def test_invalid_identity_record_reports_recovery_without_its_contents(self):
        self.configure()
        (self.directory / "identity.json").write_text("secret invalid json")
        with self.assertRaisesRegex(RuntimeError, "record is invalid; run .*remove") as error:
            signing.setup(self.directory)
        self.assertNotIn("secret", str(error.exception))

    def test_private_command_failures_never_echo_arguments_or_output(self):
        for tool, action in ((signing.SECURITY, "unlock-keychain"), (signing.OPENSSL, "pkcs12")):
            command = [tool, action, "-p", "secret-password"]
            for failure in (subprocess.TimeoutExpired(command, 60, stderr="secret-password"),
                            subprocess.CalledProcessError(1, command, stderr="secret-password"),
                            OSError(2, "secret-password")):
                with self.subTest(tool=tool, failure=type(failure).__name__), \
                     patch.object(signing.subprocess, "run", side_effect=failure):
                    with self.assertRaises(RuntimeError) as error:
                        signing.private_command(command)
                    self.assertNotIn("secret-password", str(error.exception))
                    self.assertTrue(error.exception.__suppress_context__)

    def test_setup_and_remove_hold_the_same_cross_process_lock(self):
        self.configure()
        probe = """import fcntl, os, sys
with open(sys.argv[1], 'w') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    sys.exit(1)
"""
        setup_locked, remove_locked = signing.setup_locked, signing.remove_locked
        def check_lock(operation):
            def run(directory):
                result = subprocess.run([sys.executable, "-c", probe, str(directory.with_suffix(".lock"))],
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                return operation(directory)
            return run
        with patch.object(signing, "setup_locked", side_effect=check_lock(setup_locked)), \
             patch.object(signing, "remove_locked", side_effect=check_lock(remove_locked)):
            signing.setup(self.directory)
            signing.remove(self.directory)
        with signing.identity_lock(self.directory):
            pass

    def test_build_cli_reports_signing_timeout_without_traceback_or_password(self):
        script = """import runpy, sys, subprocess
from unittest.mock import patch
from pathlib import Path
test_home = Path(sys.argv[2])
Path.home = lambda: test_home
sys.argv = [sys.argv[1], '--variant', 'dev', '--dsh-home', sys.argv[2]]
with patch('subprocess.run', side_effect=subprocess.TimeoutExpired(['security', 'unlock-keychain', '-p', 'secret-password'], 60)):
    runpy.run_path(sys.argv[0], run_name='__main__')
"""
        # Fail at the first security command, before setup can modify any keychain.
        result = subprocess.run([sys.executable, "-c", script, str(Path(signing.__file__).with_name("build_app.py")), str(self.root / "home")],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(result.stderr.splitlines()), 1)
        self.assertIn("timed out", result.stderr)
        self.assertNotIn("secret-password", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
