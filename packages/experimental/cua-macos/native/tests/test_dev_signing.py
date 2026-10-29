"""Development signing setup keeps one unlocked identity on the user keychain search list."""
import importlib.util
import json
from pathlib import Path
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

    def test_remove_restores_the_other_search_list_entries_and_deletes_the_password(self):
        security = self.configure()
        signing.remove(self.directory)
        self.assertEqual(security.keychains, [self.login])
        self.assertFalse(self.directory.exists())
        signing.remove(self.directory)
        self.assertEqual(security.keychains, [self.login])


if __name__ == "__main__":
    unittest.main()
