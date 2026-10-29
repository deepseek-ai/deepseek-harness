"""Application publication preserves complete immutable bundles and previous receipts."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import secrets
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("build_app", Path(__file__).resolve().parents[1] / "build_app.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublicationCases:
    """Publication behavior shared by release and development variants."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cua-bundle-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.binary = self.root / "native"
        self.binary.write_bytes(b"first executable")
        self.binary.chmod(0o755)
        self.plist = self.root / "Info.plist"
        self.plist.write_text("application identity")
        self.icon = self.root / "DSHComputerUse.icns"
        self.icon.write_bytes(b"computer use icon")
        for filename in ["LICENSE.computer-use-icon", "LICENSE.cua-driver"]:
            (self.root / filename).write_text("fixture license notice")
        self.output = self.root / "applications"
        self.sign = patch.object(builder.subprocess, "run")
        self.commands = self.sign.start()
        self.addCleanup(self.sign.stop)

    def publish(self):
        return builder.publish(self.binary, self.output, "-", self.plist)

    def test_unchanged_bundles_reuse_the_inode_and_changed_bundles_leave_old_clients_intact(self):
        first = self.publish()
        self.assertEqual((first.parents[1] / "Resources/DSHComputerUse.icns").read_bytes(), self.icon.read_bytes())
        inode = first.stat().st_ino
        self.assertEqual(self.publish(), first)
        self.assertEqual(first.stat().st_ino, inode)
        self.binary.write_bytes(b"second executable")
        second = self.publish()
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), b"first executable")
        self.assertEqual(second.read_bytes(), b"second executable")
        selected = json.loads((self.output / "current.json").read_text())["bundle"]
        self.assertEqual(second.parents[3].name, selected)

    def test_signing_failure_keeps_the_previous_selected_application(self):
        first = self.publish()
        previous = (self.output / "current.json").read_bytes()
        self.commands.side_effect = RuntimeError("signer unavailable")
        with self.assertRaisesRegex(RuntimeError, "signer unavailable"):
            self.publish()
        self.assertEqual((self.output / "current.json").read_bytes(), previous)
        self.assertEqual(first.read_bytes(), b"first executable")
        self.assertEqual(list(self.output.glob(".prepare-*")), [])

    def test_corrupted_retained_application_is_rejected_without_replacement(self):
        first = self.publish()
        first.write_bytes(b"damaged")
        with self.assertRaisesRegex(ValueError, "does not match its content digest"):
            self.publish()
        self.assertEqual(first.read_bytes(), b"damaged")

    def test_bundle_digest_rejects_symbolic_links_and_tracks_execute_permission(self):
        first = self.publish()
        application = first.parents[2]
        before = builder.bundle_digest(application)
        first.chmod(0o644)
        self.assertNotEqual(before, builder.bundle_digest(application))
        (application / "outside").symlink_to(self.binary)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            builder.bundle_digest(application)

    def test_bundle_digest_rejects_a_link_as_the_application_root(self):
        first = self.publish()
        linked = self.root / "linked.app"
        linked.symlink_to(first.parents[2], target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "not a real directory"):
            builder.bundle_digest(linked)


class ReleasePublicationTests(PublicationCases, unittest.TestCase):
    def test_release_identity_uses_a_secure_timestamp(self):
        builder.publish(self.binary, self.output, "Developer ID Application: Example", self.plist)
        self.assertIn("--timestamp", self.commands.call_args_list[0].args[0])
        self.assertNotIn("--timestamp=none", self.commands.call_args_list[0].args[0])

    def test_release_publication_keeps_info_plist_bytes_and_records_no_sources(self):
        first = self.publish()
        self.assertEqual((first.parents[1] / "Info.plist").read_text(), "application identity")
        self.assertEqual(sorted(path.name for path in self.output.iterdir()), sorted([first.parents[3].name, "current.json"]))


class DevelopmentPublicationTests(PublicationCases, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.plist.write_bytes(plistlib.dumps({"CFBundleIdentifier": "com.example.helper", "CFBundleName": "Helper",
                                               "CFBundleDisplayName": "Helper", "CFBundleExecutable": "dsh-cua-native"}))
        # Certificate signatures embed a signing time, so each signing pass produces different bytes.
        def sign(command, check):
            if command[1] == "--force":
                signature = Path(command[-1]) / "Contents/_CodeSignature/CodeResources"
                signature.parent.mkdir(exist_ok=True)
                signature.write_bytes(secrets.token_bytes(16))
        self.commands.side_effect = sign

    def publish(self, identity="0123456789ABCDEF0123456789ABCDEF01234567"):
        return builder.publish(self.binary, self.output, identity, self.plist, "dev", Path("/keychains/dev.keychain-db"))

    def signings(self):
        return [call.args[0] for call in self.commands.call_args_list if call.args[0][1] == "--force"]

    def test_signing_failure_keeps_the_previous_selected_application(self):
        self.publish()
        previous = (self.output / "current.json").read_bytes()
        self.binary.write_bytes(b"changed executable")
        self.commands.side_effect = RuntimeError("signer unavailable")
        with self.assertRaisesRegex(RuntimeError, "signer unavailable"):
            self.publish()
        self.assertEqual((self.output / "current.json").read_bytes(), previous)
        self.assertEqual(list(self.output.glob(".prepare-*")), [])

    def test_development_bundle_has_its_own_identifier_and_display_name(self):
        info = plistlib.loads((self.publish().parents[1] / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "com.example.helper.dev")
        self.assertEqual((info["CFBundleName"], info["CFBundleDisplayName"]), ("DSH Computer Use Dev", "DSH Computer Use Dev"))
        self.assertEqual(info["CFBundleExecutable"], "dsh-cua-native")

    def test_development_signing_uses_the_local_keychain_without_a_timestamp_server(self):
        self.publish()
        command = self.signings()[0]
        self.assertIn("--timestamp=none", command)
        self.assertEqual(command[command.index("--keychain") + 1], "/keychains/dev.keychain-db")

    def test_unchanged_content_selects_the_signed_generation_without_signing_again(self):
        first = self.publish()
        self.binary.write_bytes(b"second executable")
        second = self.publish()
        self.binary.write_bytes(b"first executable")
        self.assertEqual(self.publish(), first)
        self.assertEqual(len(self.signings()), 2)
        self.assertEqual(json.loads((self.output / "current.json").read_text())["bundle"], first.parents[3].name)
        self.assertNotEqual(second, first)

    def test_another_identity_signs_the_same_content_again(self):
        first = self.publish()
        other = self.publish("FEDCBA9876543210FEDCBA9876543210FEDCBA98")
        self.assertNotEqual(other, first)
        self.assertEqual(len(self.signings()), 2)


class SigningIdentityTests(unittest.TestCase):
    def resolve(self, variant, identity, local):
        signing = type("Signing", (), {"SETUP_COMMAND": "setup-command", "load": staticmethod(lambda: local)})
        errors = io.StringIO()
        with patch.object(builder, "load_dev_signing", return_value=signing), contextlib.redirect_stderr(errors):
            return builder.signing_identity(variant, identity), errors.getvalue()

    def test_release_builds_stay_ad_hoc_unless_an_identity_is_named(self):
        self.assertEqual(self.resolve("release", None, None), (("-", None), ""))
        self.assertEqual(self.resolve("release", "Developer ID Application: Example", None)[0], ("Developer ID Application: Example", None))

    def test_development_builds_use_the_configured_local_identity(self):
        local = type("Identity", (), {"sha1": "ABC", "keychain": Path("/keychains/dev.keychain-db")})
        self.assertEqual(self.resolve("dev", None, local), (("ABC", Path("/keychains/dev.keychain-db")), ""))

    def test_an_explicit_identity_overrides_the_local_development_identity(self):
        self.assertEqual(self.resolve("dev", "Apple Development: Example", None), (("Apple Development: Example", None), ""))

    def test_unconfigured_development_builds_are_ad_hoc_and_name_the_setup_command(self):
        (identity, errors) = self.resolve("dev", None, None)
        self.assertEqual(identity, ("-", None))
        self.assertIn("setup-command", errors)


if __name__ == "__main__":
    unittest.main()
