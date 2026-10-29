"""Smoke command failures retain native diagnostics without performing desktop operations."""
from contextlib import redirect_stderr
import io
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

import smoke


class SmokeDiagnostics(unittest.TestCase):
    def test_success_returns_captured_reply_without_replaying_it(self):
        result = subprocess.CompletedProcess(["helper"], 0, b'{"type":"ready"}', b"")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", return_value=result) as run, redirect_stderr(diagnostics):
            self.assertIs(smoke.run_checked(["helper"], 25), result)
        run.assert_called_once_with(["helper"], check=True, capture_output=True, timeout=25)
        self.assertEqual(diagnostics.getvalue(), "")

    def test_native_failure_keeps_code_message_and_stderr(self):
        error = subprocess.CalledProcessError(1, ["helper"],
                                            output='{"type":"error","code":"NATIVE_STARTUP","message":"launch failed"}',
                                            stderr="native diagnostic")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", side_effect=error), redirect_stderr(diagnostics):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                smoke.run_checked(["helper"], 25)
        self.assertIs(raised.exception, error)
        self.assertIn(error.stdout, diagnostics.getvalue())
        self.assertIn(error.stderr, diagnostics.getvalue())

    def test_timeout_keeps_partial_bytes_and_reraises(self):
        error = subprocess.TimeoutExpired(["helper"], 25, output=b"partial reply\xff", stderr=b"startup timeout")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", side_effect=error), redirect_stderr(diagnostics):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                smoke.run_checked(["helper"], 25)
        self.assertIs(raised.exception, error)
        self.assertIn("partial reply\ufffd", diagnostics.getvalue())
        self.assertIn("startup timeout", diagnostics.getvalue())

    def test_non_utf8_command_output_preserves_exit_status(self):
        for status in [0, 1]:
            with self.subTest(status=status):
                command = [sys.executable, "-c",
                           f"import os, sys; os.write(1, b'out\\xff'); os.write(2, b'err\\xfe'); sys.exit({status})"]
                diagnostics = io.StringIO()
                with redirect_stderr(diagnostics):
                    if status == 0:
                        result = smoke.run_checked(command, 10)
                        self.assertEqual(result.stdout, b"out\xff")
                        self.assertEqual(result.stderr, b"err\xfe")
                        self.assertEqual(diagnostics.getvalue(), "")
                    else:
                        with self.assertRaises(subprocess.CalledProcessError) as raised:
                            smoke.run_checked(command, 10)
                        self.assertEqual(raised.exception.returncode, status)
                        self.assertEqual(raised.exception.stdout, b"out\xff")
                        self.assertIn("out\ufffd", diagnostics.getvalue())
                        self.assertIn("err\ufffd", diagnostics.getvalue())

    def test_valid_startup_reply_stays_silent(self):
        result = subprocess.CompletedProcess(["helper"], 0, b'{"type":"ready"}', b"diagnostic")
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics):
            self.assertEqual(smoke.parse_startup_reply(result), {"type": "ready"})
        self.assertEqual(diagnostics.getvalue(), "")

    def test_empty_or_malformed_startup_reply_retains_output_and_fails(self):
        for stdout in [b"", b"launch diagnostic\n"]:
            with self.subTest(stdout=stdout):
                result = subprocess.CompletedProcess(["helper"], 0, stdout, b"native diagnostic")
                diagnostics = io.StringIO()
                with redirect_stderr(diagnostics), self.assertRaises(json.JSONDecodeError) as raised:
                    smoke.parse_startup_reply(result)
                self.assertEqual(raised.exception.doc, stdout.decode())
                self.assertIn("native diagnostic", diagnostics.getvalue())
                if stdout:
                    self.assertIn(stdout.decode(), diagnostics.getvalue())

    def test_invalid_startup_encoding_is_rejected_and_reported(self):
        result = subprocess.CompletedProcess(["helper"], 0, b'{"type":"ready", "message":"\xff"}', b"native diagnostic")
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics), self.assertRaises(UnicodeDecodeError):
            smoke.parse_startup_reply(result)
        self.assertIn('"message":"\ufffd"', diagnostics.getvalue())
        self.assertIn("native diagnostic", diagnostics.getvalue())


if __name__ == "__main__":
    unittest.main()
