"""Serialize writes to a saved Lake build and recover interrupted module traces."""

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

PENDING = ".leanflow-pending-build"
READY = ".leanflow-cache-v1"
PARTS = (".olean", ".ilean", ".ir", ".trace")


def discard_changed_traces(build, since):
    # Lake can replace a module part before it publishes the new trace.
    # Preserve untouched modules, including on recovery after a killed worker.
    for _, _, names, directory in os.fwalk(build, follow_symlinks=False):
        stale = set()
        for name in names:
            for suffix in PARTS:
                stem, match, tail = name.rpartition(suffix)
                if match and (not tail or tail.startswith(".")):
                    try:
                        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    except FileNotFoundError:
                        break
                    if info.st_ctime_ns >= since:
                        stale.add(stem + ".trace")
                    break
        for trace in stale:
            for name in (trace, trace + ".nobuild"):
                try:
                    os.unlink(name, dir_fd=directory)
                except FileNotFoundError:
                    pass


def local_cache_directories(project):
    # The runtime validates and mounts the generated directories of the Lake
    # manifest's contained path packages. Require exactly these canonical paths.
    caches = []
    for relative in json.loads(os.environ.get("LEANFLOW_LOCAL_PACKAGES", "[]")):
        parts = relative.split("/")
        if any(not part or part in (".", "..") for part in parts):
            raise ValueError("Invalid local package path")
        cache = project.joinpath(*parts, ".lake")
        if cache.resolve(strict=True) != cache or not cache.is_dir():
            raise ValueError("Invalid local package cache")
        caches.append(cache)
    return caches


def discard_project_traces(builds, since):
    for build in builds:
        if build.is_dir():
            discard_changed_traces(build, since)


@contextmanager
def locked_build(project):
    project = Path(project)
    lock = os.open(project, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        build = project / ".lake/build"
        build.mkdir(exist_ok=True)
        caches = local_cache_directories(project)
        builds = [build, *(cache / "build" for cache in caches)]
        pending = build / PENDING
        if not (build / READY).exists():
            # Older editors could write directly to this cache. Require Lake
            # to establish fresh local traces before other sessions consume it.
            discard_project_traces(builds, 0)
        if pending.exists():
            discard_project_traces(builds, pending.lstat().st_ctime_ns)
            pending.unlink()
        # An empty, exclusive marker survives SIGKILL. Readers defer until
        # the next writer has removed any incomplete traces.
        pending.touch(exist_ok=False)
        started = pending.lstat().st_ctime_ns
        revision = os.fstat(lock).st_ctime_ns
        try:
            yield lock, caches
            if revision != os.fstat(lock).st_ctime_ns:
                raise RuntimeError(
                    "Saved sources changed during the build. Retry with the current files."
                )
            (build / READY).touch(exist_ok=True)
        except BaseException:
            discard_project_traces(builds, started)
            pending.unlink(missing_ok=True)
            raise
        else:
            pending.unlink(missing_ok=True)
    finally:
        os.close(lock)


if __name__ == "__main__":
    try:
        with locked_build("/workspace") as (lock, _):
            subprocess.run(sys.argv[1:], check=True, pass_fds=(lock,))
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode if error.returncode > 0 else 128 - error.returncode)
    except (OSError, RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
