"""Application publication preserves complete immutable bundles and previous receipts."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("build_app", Path(__file__).resolve().parents[1] / "build_app.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PublicationTests(unittest.TestCase):
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

    def test_release_identity_uses_a_secure_timestamp(self):
        builder.publish(self.binary, self.output, "Developer ID Application: Example", self.plist)
        self.assertIn("--timestamp", self.commands.call_args_list[0].args[0])
        self.assertNotIn("--timestamp=none", self.commands.call_args_list[0].args[0])


if __name__ == "__main__":
    unittest.main()
