"""Seed an isolated Check File build with the traced modules selected by Lake."""

from contextlib import contextmanager, ExitStack
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
LIB = ("olean", "olean.server", "olean.private", "ilean", "ir", "ir.sig")
IR = ("c", "bc")


@contextmanager
def directory(parent, parts):
    fd = os.dup(parent)
    try:
        for part in parts:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def copy_part(parent, name, dest, remaining):
    with os.fdopen(os.open(name, READ, dir_fd=parent), "rb") as source:
        info = os.fstat(source.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_size > remaining
        ):
            raise ValueError("Unusable cache entry")
        with (dest / name).open("xb") as output:
            try:
                fcntl.ioctl(output, 0x40049409, source.fileno())  # Linux FICLONE
            except OSError:
                size = info.st_size
                while size:
                    chunk = source.read(min(size, 1024 * 1024))
                    if not chunk:
                        raise ValueError("Cache entry changed")
                    output.write(chunk)
                    size -= len(chunk)
        if os.fstat(source.fileno()).st_ctime_ns != info.st_ctime_ns:
            raise ValueError("Cache entry changed")
        return info.st_size


def copy_module(build, target, stem, remaining):
    parts = stem.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise ValueError("Invalid module")
    for base, extensions in ((("lib", "lean"), LIB), (("ir",), IR)):
        where = (*base, *parts[:-1])
        dest = target.joinpath(*where)
        required = {"trace", "olean"} if base[0] == "lib" else set()
        try:
            with directory(build, where) as src:
                dest.mkdir(mode=0o700, parents=True, exist_ok=True)
                names = [ext + suffix for ext in extensions for suffix in ("", ".hash")]
                for ext in [*names, *sorted(required - set(names))]:
                    try:
                        remaining -= copy_part(
                            src, parts[-1] + "." + ext, dest, remaining
                        )
                    except FileNotFoundError:
                        if ext in required:
                            raise
        except FileNotFoundError:
            if required:
                raise
    return remaining


def seed(project, snapshot, groups, limit):
    # The check has exclusive ownership of its captured sources until this
    # function returns. Stage all packages before publishing any build.
    lake = snapshot / ".lake"
    lake.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(
        dir=lake, prefix=".seed-"
    ) as staging, ExitStack() as handles:
        root = os.open(project, DIR)
        handles.callback(os.close, root)
        dest = os.open(snapshot, DIR)
        handles.callback(os.close, dest)
        fcntl.flock(root, fcntl.LOCK_SH)
        with directory(root, (".lake", "build")) as build:
            entries = os.listdir(build)
            if (
                ".leanflow-cache-v1" not in entries
                or ".leanflow-pending-build" in entries
            ):
                raise ValueError("Unpublished project build")
        prepared = []
        for index, (package, modules) in enumerate(groups):
            parts = package.split("/") if package else []
            if any(not part or part in (".", "..") for part in parts):
                raise ValueError("Invalid package directory")
            bucket = Path(staging) / str(index)
            with directory(root, (*parts, ".lake", "build")) as source:
                for stem in modules:
                    limit = copy_module(source, bucket, stem, limit)
            with directory(dest, parts) as target:
                try:
                    os.mkdir(".lake", mode=0o700, dir_fd=target)
                except FileExistsError:
                    pass
                target_lake = handles.enter_context(directory(target, (".lake",)))
            prepared.append((bucket, target_lake))
        committed = []
        try:
            for bucket, target in prepared:
                os.rename(bucket, "build", dst_dir_fd=target)
                committed.append((bucket, target))
        except OSError:
            for bucket, target in committed:
                try:
                    os.rename("build", bucket, src_dir_fd=target)
                except OSError:
                    # The caller disposes of the entire snapshot in this case.
                    sys.exit(2)
            raise


if __name__ == "__main__":
    try:
        seed(sys.argv[1], Path(sys.argv[2]), json.load(sys.stdin), int(sys.argv[3]))
    except (OSError, ValueError):
        sys.exit(1)
