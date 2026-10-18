"""Export project declarations in isolation, then use the pinned native checker."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


HELPER = Path(__file__).resolve().parent / "ProjectCheck.lean"


def exit_code(result):
    return result.returncode if result.returncode >= 0 else 128 - result.returncode


def sandbox(command, project, prefix, environment):
    # Match Lake's inner sandbox. The project/config/export process cannot read
    # the outer worker home or temporary export, write source, or use a network.
    args = [
        shutil.which("bwrap") or "bwrap",
        "--ro-bind",
        "/",
        "/",
        "--tmpfs",
        "/home",
        "--tmpfs",
        "/root",
        "--tmpfs",
        "/run/user",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--clearenv",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/var",
        "--ro-bind",
        str(project),
        str(project),
        "--ro-bind",
        str(prefix),
        str(prefix),
        "--ro-bind",
        str(HELPER.parent),
        str(HELPER.parent),
        "--bind",
        str(project / ".lake"),
        str(project / ".lake"),
    ]
    for key, value in environment.items():
        if key != "HOME":
            args.extend(["--setenv", key, value])
    args.extend(
        [
            "--setenv",
            "HOME",
            "/tmp/home",
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--chdir",
            str(project),
            "--",
            *command,
        ]
    )
    return args


def main():
    os.umask(0o077)
    project = Path.cwd().resolve()
    if not (project / "lake-manifest.json").is_file():
        print(
            "Prepare the project's pinned dependencies before checking it.",
            file=sys.stderr,
        )
        return 2
    if not (project / ".lake").is_dir():
        print("The project's private build cache is unavailable.", file=sys.stderr)
        return 2
    # This command only identifies the pinned installation; it loads no project
    # configuration or compiled module. All subsequent executables are absolute.
    found = subprocess.run(
        ["lean", "--print-prefix"], capture_output=True, text=True, timeout=15
    )
    if found.returncode:
        print(
            "Could not identify the project's pinned Lean installation.",
            file=sys.stderr,
        )
        return 2
    reported = found.stdout.strip()
    if (
        not reported
        or "\n" in reported
        or "\r" in reported
        or not Path(reported).is_absolute()
    ):
        print("The pinned Lean installation path is invalid.", file=sys.stderr)
        return 2
    prefix = Path(reported).resolve()
    if prefix.parent != Path("/opt/lean-toolchains"):
        print(
            "The pinned Lean installation is outside the worker's toolchains.",
            file=sys.stderr,
        )
        return 2
    environment = {
        "PATH": str(prefix / "bin") + ":/usr/bin:/bin",
        "HOME": os.environ["HOME"],
        "LEAN_ABORT_ON_PANIC": "1",
        "LEAN_NUM_THREADS": os.environ.get("LEAN_NUM_THREADS", "2"),
        # Compile the trusted helper against the toolchain only. Project oleans
        # are loaded solely by its export mode inside the inner sandbox.
        # An empty Lean search path means the current directory, so use
        # explicit trusted paths rather than empty environment values.
        "LEAN_PATH": str(prefix / "lib/lean"),
        "LEAN_SRC_PATH": str(prefix / "src/lean"),
    }
    lake = str(prefix / "bin/lake")
    helper = [
        str(prefix / "bin/lean"),
        "--load-dynlib",
        str(prefix / "lib/lean/libLake_shared.so"),
        "--run",
        str(HELPER),
    ]
    print(
        "Building the default targets and exporting all project declarations with their dependencies.",
        flush=True,
    )
    resolved = subprocess.run(
        sandbox([lake, "resolve-deps"], project, prefix, environment),
        env=environment,
        stdout=sys.stderr,
        stderr=sys.stderr,
    )
    if resolved.returncode:
        return exit_code(resolved)
    with tempfile.TemporaryDirectory(
        prefix="leanflow-project-kernel-", dir="/tmp"
    ) as directory:
        exported = Path(directory) / "project.ndjson"
        with exported.open("wb") as output:
            built = subprocess.run(
                sandbox([*helper, "export"], project, prefix, environment),
                env=environment,
                stdout=output,
                stderr=sys.stderr,
            )
        if built.returncode:
            return exit_code(built)
        if not exported.stat().st_size:
            print("The project exporter produced no declarations.", file=sys.stderr)
            return 1
        print(
            "Checking the complete exported dependency graph for forbidden axioms before kernel replay.",
            flush=True,
        )
        preflight = subprocess.run(
            [*helper, "preflight", str(exported)],
            env=environment,
            cwd=HELPER.parent,
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
        if preflight.returncode:
            return exit_code(preflight)
        print(
            "Replaying the export with the pinned native lake check; its axiom policy remains enabled.",
            flush=True,
        )
        checked = subprocess.run(
            [lake, "check", "--from-export", str(exported)],
            env=environment,
            cwd=project,
        )
        return exit_code(checked)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(
            f"Independent project checking could not complete: {error}", file=sys.stderr
        )
        sys.exit(2)
