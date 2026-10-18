import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("package-lemex.py")
spec = importlib.util.spec_from_file_location("package_lemex", SCRIPT)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class Packaging(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        for name in package.ASSETS[:-1]:
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(
                b"\x7fELF\x02\x01" + b"\0" * 12 + (62).to_bytes(2, "little")
            )
        (self.source / "codex-package.json").write_text(
            json.dumps(
                {
                    "version": package.RELEASE["version"],
                    "target": package.TARGETS["x64"],
                }
            )
        )
        self.destination = self.root / "bundle"

    def build(self):
        return subprocess.run(
            [
                sys.executable,
                "-I",
                str(SCRIPT),
                "--target-arch",
                "x64",
                "--source",
                str(self.source),
                "--destination",
                str(self.destination),
            ],
            capture_output=True,
            text=True,
        )

    def test_local_install_has_only_release_assets_and_rcp_defaults(self):
        (self.source / "auth.json").write_text('"fixture-private-auth"')
        (self.source / "config.toml").write_text('api_key = "fixture-private-auth"')
        self.assertEqual(self.build().returncode, 0)
        config = (self.destination / "config.toml").read_text()
        self.assertIn('model_provider = "rcp"', config)
        self.assertIn('model_reasoning_effort = "max"', config)
        self.assertIn("model_context_window = 240000", config)
        self.assertFalse((self.destination / "auth.json").exists())
        for path in self.destination.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"fixture-private-auth", path.read_bytes())
        manifest = json.loads((self.destination / "manifest.json").read_text())
        self.assertEqual(
            manifest["provenance_verification"], "installed_native_runtime"
        )
        self.assertIsNone(manifest["npm_integrity"])
        for name, expected in manifest["files"].items():
            self.assertEqual(package.sha256(self.destination / name), expected)

    def test_bad_architecture_or_symlinks_cannot_replace_a_good_bundle(self):
        self.assertEqual(self.build().returncode, 0)
        before = (self.destination / "manifest.json").read_bytes()
        (self.source / "bin/lemex").write_bytes(b"not-native")
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual((self.destination / "manifest.json").read_bytes(), before)
        (self.source / "bin/lemex").unlink()
        (self.source / "bin/lemex").symlink_to(self.source / "bin/lemex-code-mode-host")
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual((self.destination / "manifest.json").read_bytes(), before)

    def test_tarball_integrity_identity_and_regular_members_are_required(self):
        archive_path = self.root / "runtime.tgz"
        with tarfile.open(archive_path, "w:gz") as archive:
            data = json.dumps(
                {
                    "name": package.RELEASE["package"],
                    "version": package.RELEASE["version"] + "-linux-x64",
                }
            ).encode()
            member = tarfile.TarInfo("package/package.json")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
            member = tarfile.TarInfo(
                "package/vendor/" + package.TARGETS["x64"] + "/bin/lemex"
            )
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            archive.addfile(member)
        integrity = (
            "sha512-"
            + base64.b64encode(
                hashlib.sha512(archive_path.read_bytes()).digest()
            ).decode()
        )
        with self.assertRaisesRegex(ValueError, "integrity"):
            package.extract_runtime(archive_path, self.root, "x64", "sha512-wrong")
        with self.assertRaisesRegex(ValueError, "regular"):
            package.extract_runtime(archive_path, self.root, "x64", integrity)


if __name__ == "__main__":
    unittest.main()
