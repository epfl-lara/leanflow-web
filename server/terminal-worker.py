"""Bridge a worker's interactive PTY to JSON input and raw byte output."""

import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios


def configure_git():
    # This first, bounded frame contains only a public commit identity. The
    # parent waits for the credential broker before allowing the shell to run.
    frame = b""
    while not frame.endswith(b"\n"):
        chunk = os.read(0, 1)
        if not chunk or len(frame) >= 16384:
            raise ValueError("Terminal setup is unavailable")
        frame += chunk
    setup = json.loads(frame)
    if not isinstance(setup, dict) or setup.get("type") != "setup":
        raise ValueError("Invalid terminal setup")
    identity = setup.get("identity") or {}
    if not isinstance(identity, dict):
        raise ValueError("Invalid Git identity")
    for key, limit in [("name", 200), ("email", 254)]:
        value = identity.get(key)
        if value:
            if (
                not isinstance(value, str)
                or len(value) > limit
                or any(ord(char) < 32 or ord(char) == 127 for char in value)
            ):
                raise ValueError("Invalid Git identity")
            subprocess.run(
                ["git", "config", "--global", "user." + key, value],
                check=True,
                stdin=subprocess.DEVNULL,
            )


def main():
    configure_git()
    pid, master = pty.fork()
    if pid == 0:
        os.execvp("bash", ["bash", "--noprofile", "--norc", "-i"])

    os.set_blocking(master, False)
    incoming = b""
    pending = b""
    try:
        while True:
            readable, writable, _ = select.select(
                [master, 0] if len(pending) < 65536 else [master],
                [master] if pending else [],
                [],
            )
            if master in readable:
                try:
                    output = os.read(master, 16384)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not output:
                    break
                sys.stdout.buffer.write(output)
                sys.stdout.buffer.flush()
            if master in writable:
                try:
                    pending = pending[os.write(master, pending) :]
                except BlockingIOError:
                    pass
            if 0 in readable:
                chunk = os.read(0, 16384)
                if not chunk:
                    break
                incoming += chunk
                if len(incoming) > 131072:
                    raise ValueError("Terminal input is too large")
                while b"\n" in incoming:
                    line, incoming = incoming.split(b"\n", 1)
                    message = json.loads(line)
                    if message["type"] == "input":
                        pending += message["data"].encode("utf-8")
                        if len(pending) > 131072:
                            raise ValueError("Terminal input is too large")
                    elif message["type"] == "resize":
                        fcntl.ioctl(
                            master,
                            termios.TIOCSWINSZ,
                            struct.pack("HHHH", message["rows"], message["cols"], 0, 0),
                        )
    finally:
        os.close(master)
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    sys.exit(main())
