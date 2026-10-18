#!/usr/bin/env python3
"""Package the pinned npm native runtime without personal config or credentials."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
RELEASE = json.loads((ROOT / "deploy/lemex-runtime.json").read_text())
TARGETS = {"x64": "x86_64-unknown-linux-musl", "arm64": "aarch64-unknown-linux-musl"}
ASSETS = [
    "bin/lemex",
    "bin/lemex-code-mode-host",
    "codex-path/rg",
    "codex-resources/bwrap",
    "codex-package.json",
]


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def extract_runtime(tarball, destination, architecture, integrity):
    with tarball.open("rb") as stream:
        actual = (
            "sha512-"
            + base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode()
        )
    if actual != integrity:
        raise ValueError("npm tarball integrity does not match the pinned release")
    target = TARGETS[architecture]
    with tarfile.open(tarball, "r:gz") as archive:
        package = json.load(archive.extractfile("package/package.json"))
        if (
            package.get("name") != RELEASE["package"]
            or package.get("version") != f'{RELEASE["version"]}-linux-{architecture}'
        ):
            raise ValueError("Unexpected npm package identity")
        for name in ASSETS:
            member = archive.getmember(f"package/vendor/{target}/{name}")
            if not member.isfile() or member.size > 512 * 1024 * 1024:
                raise ValueError("Runtime assets must be bounded regular files")
            output = destination / name
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, output.open("wb") as stream:
                shutil.copyfileobj(source, stream)
        for name in ["LICENSE", "NOTICE"]:
            member = archive.getmember("package/" + name)
            if not member.isfile() or member.size > 1024 * 1024:
                raise ValueError("Missing npm license or notices")
            with archive.extractfile(member) as source, (destination / name).open(
                "wb"
            ) as output:
                shutil.copyfileobj(source, output)


def validate_runtime(directory, architecture):
    metadata = json.loads((directory / "codex-package.json").read_text())
    if (
        metadata.get("target") != TARGETS[architecture]
        or metadata.get("version") != RELEASE["version"]
    ):
        raise ValueError(
            "Native runtime target/version does not match the pinned npm release"
        )
    machine = {"x64": 62, "arm64": 183}[architecture]
    for name in ASSETS[:-1]:
        with (directory / name).open("rb") as stream:
            header = stream.read(20)
        if (
            len(header) < 20
            or header[:6] != b"\x7fELF\x02\x01"
            or int.from_bytes(header[18:20], "little") != machine
        ):
            raise ValueError(
                f"Expected a native Linux {architecture} executable: {name}"
            )


def defaults(directory):
    (directory / "config.toml").write_text(
        """# LeanFlow defaults. Account credentials are supplied per process.
model_provider = "rcp"
model = "deepseek-ai/DeepSeek-V4.1-Flash-1017"
model_reasoning_effort = "max"
model_context_window = 240000
model_auto_compact_token_limit = 220000
model_catalog_json = "models.json"
sandbox_mode = "danger-full-access"
approval_policy = "never"
web_search = "disabled"

[model_providers.rcp]
name = "RCP"
base_url = "https://inference.rcp.epfl.ch/v1"
env_key = "LEMEX_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = false
"""
    )
    shutil.copyfile(ROOT / "server/lemex-models.json", directory / "models.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", default=".runtime/lemex")
    parser.add_argument(
        "--target-arch",
        choices=TARGETS,
        default={"x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(
            platform.machine()
        ),
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Optional already installed native vendor directory at the pinned npm version",
    )
    args = parser.parse_args()
    if args.target_arch not in TARGETS:
        parser.error("Use --target-arch x64 or arm64 for the Linux Docker host")
    target = Path(args.destination).absolute()
    if target.is_symlink() or target == ROOT or ROOT.is_relative_to(target):
        raise ValueError("Use a dedicated runtime destination")
    target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="lemex-npm-", dir=target.parent
    ) as temporary:
        staging = Path(temporary)
        bundle = staging / "runtime"
        bundle.mkdir()
        integrity = RELEASE["integrity"][args.target_arch]
        if args.source:
            for name in ASSETS:
                source = args.source / name
                if source.is_symlink() or not source.is_file():
                    raise ValueError(f"Missing regular native asset: {name}")
                output = bundle / name
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, output)
            origin = "installed_native_runtime"
        else:
            package = (
                f'{RELEASE["package"]}@{RELEASE["version"]}-linux-{args.target_arch}'
            )
            environment = {
                "PATH": os.environ["PATH"],
                "HOME": str(staging),
                "npm_config_cache": str(staging / "npm-cache"),
            }
            packed = json.loads(
                subprocess.check_output(
                    [
                        "npm",
                        "pack",
                        "--json",
                        "--ignore-scripts",
                        "--registry=https://registry.npmjs.org/",
                        package,
                    ],
                    cwd=staging,
                    env=environment,
                    text=True,
                )
            )
            if len(packed) != 1 or packed[0].get("integrity") != integrity:
                raise ValueError("npm returned an unexpected release integrity")
            filename = Path(packed[0]["filename"])
            if filename.name != str(filename):
                raise ValueError("Invalid npm archive filename")
            extract_runtime(staging / filename, bundle, args.target_arch, integrity)
            origin = "npm_registry_integrity"
        validate_runtime(bundle, args.target_arch)
        defaults(bundle)
        manifest = {
            "version": RELEASE["version"],
            "npm_package": RELEASE["package"],
            "npm_version": f'{RELEASE["version"]}-linux-{args.target_arch}',
            "npm_integrity": integrity if not args.source else None,
            "native_target": TARGETS[args.target_arch],
            "provenance_verification": origin,
            "native_artifact_sha256": {
                name: sha256(bundle / "bin" / name)
                for name in ["lemex", "lemex-code-mode-host"]
            },
        }
        (bundle / "lemex-install.json").write_text(
            json.dumps(manifest, indent=2) + "\n"
        )
        manifest["files"] = {
            str(path.relative_to(bundle)): sha256(path)
            for path in sorted(bundle.rglob("*"))
            if path.is_file()
        }
        (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for directory in [bundle, *[p for p in bundle.rglob("*") if p.is_dir()]]:
            directory.chmod(0o755)
        for asset in ASSETS[:-1]:
            (bundle / asset).chmod(0o755)
        for path in bundle.rglob("*"):
            if path.is_file() and str(path.relative_to(bundle)) not in ASSETS[:-1]:
                path.chmod(0o644)
        if target.exists():
            if not (target / "manifest.json").is_file():
                raise ValueError(
                    "Refusing to replace a directory without a generated runtime manifest"
                )
            shutil.rmtree(target)
        bundle.rename(target)
    print(
        f'Packaged {RELEASE["package"]} {RELEASE["version"]} for Linux {args.target_arch} into {target}'
    )


if __name__ == "__main__":
    main()
