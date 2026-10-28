"""Reference helper paths work at every filesystem depth."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_test_support import copy_helper, unregister_helper


class ReferencePathTests(unittest.TestCase):
    def test_shallow_reference_path_reaches_the_bare_copy_and_needs_no_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            source = Path("/opt/reference-helper")
            with patch.object(Path, "resolve", return_value=source), patch("native_test_support.shutil.copy2") as copy:
                self.assertEqual(copy_helper(source, destination), destination / "helper")
                copy.assert_called_once_with(source, destination / "helper")
            with patch("native_test_support.subprocess.run") as run:
                unregister_helper(source)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
