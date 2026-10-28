"""Fixture artifacts and every owned process receive their cleanup attempt."""
import unittest

from native_test_support import run_cleanup


class CleanupTests(unittest.TestCase):
    def test_artifact_failure_does_not_skip_either_process(self):
        calls = []

        def artifacts():
            calls.append("artifacts")
            raise OSError("cannot save artifacts")

        with self.assertRaisesRegex(OSError, "cannot save artifacts"):
            run_cleanup(artifacts, lambda: calls.append("helper"), lambda: calls.append("fixture"))
        self.assertEqual(calls, ["artifacts", "helper", "fixture"])

    def test_helper_failure_still_stops_the_fixture_and_keeps_the_first_error(self):
        calls = []

        def artifacts():
            calls.append("artifacts")
            raise OSError("cannot save artifacts")

        def helper():
            calls.append("helper")
            raise RuntimeError("helper did not exit")

        with self.assertRaisesRegex(RuntimeError, "helper did not exit") as caught:
            run_cleanup(artifacts, helper, lambda: calls.append("fixture"))
        self.assertEqual(calls, ["artifacts", "helper", "fixture"])
        self.assertIsInstance(caught.exception.__context__, OSError)

    def test_successful_cleanup_runs_in_order(self):
        calls = []
        run_cleanup(lambda: calls.append("helper"), lambda: calls.append("fixture"))
        self.assertEqual(calls, ["helper", "fixture"])


if __name__ == "__main__":
    unittest.main()
