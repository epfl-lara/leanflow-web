"""Offline lifecycle tests for the pinned worker's LeanProbe integration."""

import runpy
import sys
import threading
import types
import unittest
from pathlib import Path


class WorkerSessionsTest(unittest.TestCase):
    def setUp(self):
        self.original_modules = {
            name: sys.modules.get(name)
            for name in ["lean_probe", "lean_probe.errors", "lean_probe.probe"]
        }
        package = types.ModuleType("lean_probe")
        errors = types.ModuleType("lean_probe.errors")
        errors._dead_server_error = lambda error: "broken pipe" in error.lower()
        backend = types.ModuleType("lean_probe.probe")

        class Probe:
            def __init__(self):
                self._lock = threading.RLock()
                self._scratch_sessions = {}
                self._sessions = {"file": object()}
                self._code_sessions = {"proof": object()}
                self.closed = []
                self.active = 0
                self.maximum_active = 0
                self.entered = threading.Event()
                self.proceed = threading.Event()
                self.sequence = []

            def _resolve_project_root(self, cwd):
                return None if cwd == "missing" else cwd

            def _drop_scratch_session(self, root):
                self.sequence.append(("close", root))
                previous = self._scratch_sessions.pop(root, None)
                if previous is not None:
                    self.closed.append(previous)

            def check_code(self, code, **kwargs):
                with self._lock:
                    cwd = kwargs.get("cwd")
                    if cwd == "missing":
                        return {"success": False, "error_code": "no_project_root"}
                    self.active += 1
                    self.maximum_active = max(self.maximum_active, self.active)
                    self.sequence.append(("start", cwd))
                    session = self._scratch_sessions.setdefault(cwd, object())
                    try:
                        if code == "wait":
                            self.entered.set()
                            assert self.proceed.wait(3)
                        if code == "raise":
                            raise RuntimeError("original failure")
                        self.sequence.append(("finish", cwd))
                        return {"success": True, "session": session, "kwargs": kwargs}
                    finally:
                        self.active -= 1

        backend.LeanProbe = Probe
        package.errors = errors
        sys.modules.update(
            {
                "lean_probe": package,
                "lean_probe.errors": errors,
                "lean_probe.probe": backend,
            }
        )
        wrapper = runpy.run_path(
            str(Path(__file__).resolve().parents[1] / "deploy" / "lean-probe-worker")
        )
        wrapper["configure_probe_sessions"]()
        self.Probe = Probe
        self.errors = errors

    def tearDown(self):
        for name, previous in self.original_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    def test_repeated_snippets_release_scratch_but_preserve_file_and_proof_states(self):
        probe = self.Probe()
        files, proofs = probe._sessions.copy(), probe._code_sessions.copy()
        for _ in range(8):
            result = probe.check_code(
                "import Mathlib", cwd="project", timeout_s=90, include_tactics=True
            )
            self.assertEqual(
                result["kwargs"],
                {"cwd": "project", "timeout_s": 90, "include_tactics": True},
            )
            self.assertEqual(probe._scratch_sessions, {})
            self.assertEqual(probe._sessions, files)
            self.assertEqual(probe._code_sessions, proofs)
        self.assertEqual(len(probe.closed), 8)
        self.assertEqual(len({id(session) for session in probe.closed}), 8)

    def test_cleanup_runs_on_backend_exceptions_and_does_not_retry_them(self):
        probe = self.Probe()
        with self.assertRaisesRegex(RuntimeError, "original failure"):
            probe.check_code("raise", cwd="project")
        self.assertEqual(probe._scratch_sessions, {})
        self.assertEqual(len(probe.closed), 1)
        self.assertEqual(probe.sequence, [("start", "project"), ("close", "project")])

    def test_missing_project_does_not_retire_unrelated_standalone_session(self):
        probe = self.Probe()
        unrelated = object()
        probe._scratch_sessions[None] = unrelated
        self.assertEqual(
            probe.check_code("code", cwd="missing")["error_code"], "no_project_root"
        )
        self.assertIs(probe._scratch_sessions[None], unrelated)
        probe.check_code("standalone")
        self.assertEqual(probe._scratch_sessions, {})

    def test_parallel_requests_do_not_close_another_active_scratch_session(self):
        probe = self.Probe()
        results = []
        first = threading.Thread(
            target=lambda: results.append(probe.check_code("wait", cwd="project"))
        )
        second = threading.Thread(
            target=lambda: results.append(probe.check_code("code", cwd="project"))
        )
        first.start()
        self.assertTrue(probe.entered.wait(3))
        second.start()
        self.assertEqual(probe.closed, [])
        probe.proceed.set()
        first.join(3)
        second.join(3)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(len(results), 2)
        self.assertEqual(probe.maximum_active, 1)
        self.assertEqual(
            probe.sequence,
            [("start", "project"), ("finish", "project"), ("close", "project")] * 2,
        )
        self.assertIsNot(results[0]["session"], results[1]["session"])

    def test_only_recognized_closed_server_errors_gain_existing_dead_server_recovery(
        self,
    ):
        self.assertTrue(
            self.errors._dead_server_error(
                "The Lean server closed unexpectedly. stdout: stderr:"
            )
        )
        self.assertTrue(self.errors._dead_server_error("broken pipe"))
        self.assertFalse(self.errors._dead_server_error("type mismatch"))
        self.assertFalse(self.errors._dead_server_error("timeout"))
        self.assertFalse(
            self.errors._dead_server_error("some unrelated server closed unexpectedly")
        )


if __name__ == "__main__":
    unittest.main()
