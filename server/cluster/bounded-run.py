"""Seed a disposable, memory-backed home before running a pure check."""

import os
import shutil
import subprocess
import sys

os.umask(0o077)
if len(sys.argv) < 2:
    raise SystemExit("Missing pure-check command")
shutil.copytree(
    "/opt/leanflow-home-seed",
    "/home/worker",
    symlinks=True,
    dirs_exist_ok=True,
)
arguments = sys.argv[1:]
selected = None
if arguments[0] == "--then-lean":
    if len(arguments) < 5 or arguments[2] != "--":
        raise SystemExit("Invalid selected-file check")
    selected = arguments[1]
    if (
        not selected.endswith(".lean")
        or selected.startswith("/")
        or any(part in ("", ".", "..") for part in selected.split("/"))
        or "\\" in selected
        or any(ord(character) < 32 for character in selected)
    ):
        raise SystemExit("Invalid selected-file check")
    arguments = arguments[3:]
elif arguments[0] == "--":
    arguments = arguments[1:]
if not arguments:
    raise SystemExit("Missing pure-check command")
if selected is not None:
    completed = subprocess.run(arguments, check=False)
    if completed.returncode:
        raise SystemExit(
            completed.returncode
            if completed.returncode > 0
            else 128 - completed.returncode
        )
    arguments = ["lake", "env", "lean", "--json", "-Dwarn.sorry=true", "./" + selected]
os.execvpe(arguments[0], arguments, os.environ)
