"""Application publication preserves complete immutable bundles and previous receipts."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import secrets
import sys
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
        self.assertEqual(first.parents[2].name, "DSH Computer Use.app")
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
        executable = self.publish()
        self.assertEqual(executable.parents[2].name, "DSH Computer Use Dev.app")
        info = plistlib.loads((executable.parents[1] / "Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], "com.example.helper.dev")
        self.assertEqual((info["CFBundleName"], info["CFBundleDisplayName"]), ("DSH Computer Use Dev", "DSH Computer Use Dev"))
        self.assertEqual(info["CFBundleExecutable"], "dsh-cua-native")

    def test_old_bundle_filename_is_republished_without_deleting_the_running_generation(self):
        first = self.publish()
        legacy = first.parents[2].with_name("DSH Computer Use.app")
        first.parents[2].rename(legacy)
        second = self.publish()
        self.assertEqual(second.parents[2].name, "DSH Computer Use Dev.app")
        self.assertTrue(second.is_file())
        self.assertTrue((legacy / "Contents/MacOS/dsh-cua-native").is_file())
        self.assertEqual(len(self.signings()), 2)

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

    def test_named_identities_are_resigned_in_case_the_certificate_was_renewed(self):
        first = self.publish("Apple Development: Example")
        self.assertNotEqual(self.publish("Apple Development: Example"), first)
        self.assertEqual(len(self.signings()), 2)

    def test_switching_between_ad_hoc_and_configured_identity_selects_the_matching_generation(self):
        ad_hoc = self.publish("-")
        local = self.publish()
        self.assertNotEqual(local, ad_hoc)
        self.assertEqual(self.publish("-"), ad_hoc)
        self.assertEqual(self.publish(), local)
        self.assertEqual(len(self.signings()), 2)

    def test_another_identity_signs_the_same_content_again(self):
        first = self.publish()
        other = self.publish("FEDCBA9876543210FEDCBA9876543210FEDCBA98")
        self.assertNotEqual(other, first)
        self.assertEqual(len(self.signings()), 2)


class SigningOptionsTests(unittest.TestCase):
    def test_default_dev_and_release_builds_use_ad_hoc_without_keychain_commands(self):
        for variant in ("dev", "release"):
            with self.subTest(variant=variant), patch.object(sys, "argv", ["build_app.py", "--variant", variant]), \
                 patch.object(builder.subprocess, "run") as run, patch.object(builder, "publish", return_value="helper") as publish, \
                 contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            self.assertEqual(len(run.call_args_list), 1)
            self.assertEqual(run.call_args.args[0][:3], ["/usr/bin/xcrun", "swift", "build"])
            self.assertEqual(publish.call_args.args[2], "-")
            self.assertEqual(publish.call_args.args[4:], (variant, None))

    def test_custom_certificate_and_keychain_reach_the_signer(self):
        for flags, keychain in (([], None), (["--keychain", "/keychains/user.keychain-db"], Path("/keychains/user.keychain-db"))):
            with patch.object(sys, "argv", ["build_app.py", "--variant", "dev", "--identity", "Example", *flags]), \
                 patch.object(builder.subprocess, "run"), patch.object(builder, "publish", return_value="helper") as publish, \
                 contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            self.assertEqual(publish.call_args.args[2], "Example")
            self.assertEqual(publish.call_args.args[4:], ("dev", keychain))

    def test_invalid_or_retired_signing_options_fail_before_building(self):
        for flags in (["--signing", "local-identity"], ["--dsh-home", "/home/example"],
                      ["--keychain", "/keychains/user"], ["--identity", "Example", "--keychain", "relative"], ["--identity", " "]):
            with self.subTest(flags=flags), patch.object(sys, "argv", ["build_app.py", *flags]), \
                 patch.object(builder.subprocess, "run") as run, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    builder.main()
                self.assertEqual(error.exception.code, 2)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
