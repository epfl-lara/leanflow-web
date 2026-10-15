"""Compile an immutable, untrusted project inside the dedicated TeX container."""

import json
import base64
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile


MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_PDF_BYTES = 16 * 1024 * 1024
MAX_TEXT_BYTES = 512 * 1024
MAX_LOG_BYTES = 256 * 1024
MAX_FILES = 4096
SOURCE = Path("/workspace")
OUTPUT = Path("/output")


def regular_file(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("A build file is not regular or exceeds its size limit.")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def copy_sources(destination):
    total = 0
    count = 0
    for directory, directories, files in os.walk(SOURCE, followlinks=False):
        current = Path(directory)
        for name in directories + files:
            entry = current / name
            if entry.is_symlink():
                raise ValueError("LaTeX project files cannot contain symbolic links.")
        directories[:] = [
            name
            for name in directories
            if name not in {".git", ".lake", "node_modules", ".lemex", ".codex"}
        ]
        relative = current.relative_to(SOURCE)
        if len(relative.parts) > 64:
            raise ValueError("The LaTeX project contains too many nested folders.")
        target = destination / relative
        target.mkdir(parents=True, exist_ok=True)
        for name in files:
            count += 1
            if count > MAX_FILES:
                raise ValueError("LaTeX projects must contain at most 4,096 files.")
            if name == ".env" or name.startswith(".env."):
                raise ValueError("Private configuration cannot be compiled.")
            with regular_file(current / name, MAX_SOURCE_BYTES - total) as stream:
                with (target / name).open("xb") as copied:
                    while data := stream.read(64 * 1024):
                        total += len(data)
                        if total > MAX_SOURCE_BYTES:
                            raise ValueError(
                                "LaTeX project sources must total at most 64 MiB."
                            )
                        copied.write(data)


def compiler_environment(home):
    # Do not inherit arbitrary TEXINPUTS, TEXMFCNF, Perl, Python, or provider
    # settings. The system configuration remains available; project-local
    # texmf.cnf and latexmkrc files cannot enable commands or relaxed I/O.
    home.mkdir(mode=0o700)
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(home),
        "TMPDIR": "/tmp",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TEXMFCNF": "/etc/texmf/web2c:/usr/share/texlive/texmf-dist/web2c",
        "TEXMFHOME": str(home / "texmf"),
        "TEXMFCONFIG": str(home / "config"),
        "TEXMFVAR": str(home / "var"),
        "openin_any": "p",
        "openout_any": "p",
        "shell_escape": "f",
        "shell_escape_commands": "",
        "max_print_line": "10000",
    }


def capture(command, cwd, env, limit=MAX_LOG_BYTES, stream_output=False, tail=False):
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    captured = bytearray()
    truncated = False
    streamed = 0
    while data := process.stdout.read1(8192):
        if tail:
            captured.extend(data)
            if len(captured) > limit:
                del captured[:-limit]
                truncated = True
        else:
            remaining = max(0, limit - len(captured))
            captured.extend(data[:remaining])
            if len(data) > remaining:
                truncated = True
        streamed_chunk = data[: max(0, limit - streamed)]
        if stream_output and streamed_chunk:
            sys.stdout.buffer.write(streamed_chunk)
            sys.stdout.buffer.flush()
            streamed += len(streamed_chunk)
    process.stdout.close()
    code = process.wait()
    text = captured.decode("utf-8", errors="replace")
    if truncated:
        if tail:
            text = "[Earlier compiler output truncated.]\n" + text
        else:
            text += "\n[Output truncated to the build display limit.]\n"
    return code, text, truncated


def diagnostic_file(filename, work, cwd):
    candidate = (cwd / filename).resolve()
    try:
        return candidate.relative_to(work).as_posix()
    except ValueError:
        return None


def diagnostics_from(log, work, cwd, entry_file, root_file):
    result = []
    seen = set()
    for line in log.splitlines():
        entry = None
        match = re.match(
            r"^(.+\.(?:tex|sty|cls|bib|bst|tikz|pgf|ltx|bbl)):(\d+):\s*(.+)$", line
        )
        if match:
            filename = diagnostic_file(match[1], work, cwd)
            if filename == entry_file:
                filename = root_file
            entry = {
                "severity": "warning" if "warning" in match[3].lower() else "error",
                "message": match[3][:2000],
            }
            if filename:
                entry.update(file=filename, line=int(match[2]))
        elif line.startswith("!"):
            entry = {"severity": "error", "message": line.lstrip("! ")[:2000]}
        elif re.match(r"^(?:LaTeX|Package .+|Class .+) Warning:", line):
            entry = {"severity": "warning", "message": line[:2000]}
        if entry and entry["message"]:
            fingerprint = json.dumps(entry, sort_keys=True)
            if fingerprint not in seen:
                seen.add(fingerprint)
                result.append(entry)
        if len(result) >= 100:
            break
    return result


def final_log(path):
    try:
        with regular_file(path, 32 * 1024 * 1024) as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - MAX_LOG_BYTES))
            return stream.read(MAX_LOG_BYTES).decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def bibliography_diagnostics(log):
    result = []
    for line in log.splitlines():
        if re.search(
            r"(?:I couldn't open|I found no|Repeated entry|error message|Warning--)",
            line,
        ):
            result.append(
                {
                    "severity": "warning" if "Warning--" in line else "error",
                    "message": line[:2000],
                }
            )
        if len(result) >= 50:
            break
    return result


def write_output(name, content):
    # No compiler-produced paths become host output destinations. Create each
    # fixed artifact without following links, then publish it atomically.
    temporary = OUTPUT / ("." + name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)
    os.replace(temporary, OUTPUT / name)


def compile_project(root_file):
    if (
        len(root_file) > 1024
        or not root_file.lower().endswith(".tex")
        or root_file.startswith("/")
        or "\\" in root_file
        or re.search(r"[\x00-\x1f]", root_file)
        or any(part in {"", ".", ".."} for part in root_file.split("/"))
    ):
        raise ValueError("Choose a supported relative .tex main file.")
    with tempfile.TemporaryDirectory(prefix="leanflow-tex-", dir="/tmp") as temporary:
        stage = Path(temporary)
        work = stage / "source"
        copy_sources(work)
        root = work / root_file
        with regular_file(root, 8 * 1024 * 1024) as stream:
            source = stream.read(8 * 1024 * 1024 + 1)
        if len(source) > 8 * 1024 * 1024:
            raise ValueError("The main TeX file must be at most 8 MiB.")
        header = source[:16384].decode("utf-8-sig", errors="replace")
        requested = re.search(
            r"^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*(\S+)",
            header,
            flags=re.IGNORECASE | re.MULTILINE,
        )
        if requested and requested[1].lower() != "pdflatex":
            raise ValueError(
                "This main file requests "
                + requested[1][:80]
                + "; this server currently supports pdfLaTeX only."
            )
        env = compiler_environment(stage / "home")
        cwd = root.parent
        # latexmk invokes engine commands through a shell. Compile the exact
        # main contents under a generated safe name in the same source folder,
        # so user-controlled filenames never become shell command fragments.
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix="leanflow-root-", suffix=".tex", dir=cwd, delete=False
        ) as entry:
            entry.write(source)
            entry_path = Path(entry.name)
        build = stage / "build"
        build.mkdir()
        # \include writes chapter aux files beneath the output directory.
        # Recreate only captured descendant directories, never parent paths.
        for directory in cwd.rglob("*"):
            if directory.is_dir():
                (build / directory.relative_to(cwd)).mkdir(parents=True, exist_ok=True)
        versions = {}
        for executable in ["latexmk", "pdflatex", "bibtex"]:
            version_command = [executable]
            if executable == "latexmk":
                version_command.append("-norc")
            version_command.append("--version")
            _, version, _ = capture(version_command, cwd, env, limit=4096)
            versions[executable] = (
                version.strip().splitlines()[0] if version.strip() else ""
            )
        command = [
            "latexmk",
            "-norc",
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            "-pdflatex=pdflatex -no-shell-escape %O %S",
            "-e",
            "$max_repeat=5; $biber='false'; $makeindex='makeindex -o "
            + str(build / "document.ind")
            + " "
            + str(build / "document.idx")
            + "';",
            "-jobname=document",
            "-outdir=" + str(build),
            "./" + entry_path.name,
        ]
        code, log, log_truncated = capture(
            command, cwd, env, stream_output=True, tail=True
        )
        tex_log = final_log(build / "document.log")
        entries = diagnostics_from(
            tex_log or log,
            work,
            cwd,
            entry_path.relative_to(work).as_posix(),
            root_file,
        )
        entries.extend(bibliography_diagnostics(final_log(build / "document.blg")))
        if re.search(r"(?:rule ['\"]biber|Run number [^\n]*biber)", log, re.IGNORECASE):
            entries.append(
                {
                    "severity": "error",
                    "message": "Biber is unavailable. Use BibTeX for this document; other bibliography engines are not substituted.",
                }
            )
        if re.search(r"Not reading from[^\n]*\.\./", log):
            entries.append(
                {
                    "severity": "error",
                    "message": "Parent-directory inputs are not supported by this compiler. Put the main TeX file at the common project root and use paths below it.",
                }
            )
        pdf = build / "document.pdf"
        success = code == 0
        text_truncated = False
        text_available = False
        page_count = None
        if success:
            with regular_file(pdf, MAX_PDF_BYTES) as stream:
                content = stream.read(MAX_PDF_BYTES + 1)
            if not content.startswith(b"%PDF-") or len(content) > MAX_PDF_BYTES:
                raise ValueError(
                    "The compiler did not produce a supported PDF under 16 MiB."
                )
            write_output("document.pdf", content)
            _, pdf_info, _ = capture(["pdfinfo", str(pdf)], cwd, env, limit=16384)
            page_match = re.search(r"^Pages:\s+(\d+)\s*$", pdf_info, re.MULTILINE)
            if page_match:
                page_count = int(page_match[1])
            text_code, text, text_truncated = capture(
                [
                    "pdftotext",
                    "-layout",
                    "-enc",
                    "UTF-8",
                    "-f",
                    "1",
                    "-l",
                    "200",
                    str(pdf),
                    "-",
                ],
                cwd,
                env,
                limit=MAX_TEXT_BYTES - 256,
            )
            if text_code:
                text = ""
                entries.append(
                    {
                        "severity": "warning",
                        "message": "PDF text extraction was unavailable.",
                    }
                )
            else:
                text_available = True
            if page_count is not None and page_count > 200:
                text_truncated = True
                text += "\n[PDF text limited to the first 200 pages.]\n"
            encoded_text = text.encode("utf-8")
            if len(encoded_text) > MAX_TEXT_BYTES:
                text_truncated = True
                encoded_text = (
                    encoded_text[:MAX_TEXT_BYTES]
                    .decode("utf-8", errors="ignore")
                    .encode("utf-8")
                )
            write_output("document.txt", encoded_text)
        elif not any(entry["severity"] == "error" for entry in entries):
            entries.append(
                {
                    "severity": "error",
                    "message": "LaTeX compilation failed. Read the build output for details.",
                }
            )
        return {
            "schema": 1,
            "engine": "pdflatex",
            "rootFile": root_file,
            "success": success,
            "diagnostics": entries,
            "log": log,
            "logTruncated": log_truncated,
            "versions": versions,
            "textTruncated": text_truncated,
            "textAvailable": text_available,
            "pageCount": page_count,
        }, code


def main():
    os.umask(0o077)
    root_file = sys.argv[1] if len(sys.argv) == 3 else ""
    token = sys.argv[2] if len(sys.argv) == 3 else ""
    if not re.fullmatch(r"[a-f0-9-]{36}", token):
        raise ValueError("Invalid artifact transfer token.")
    try:
        result, code = compile_project(root_file)
    except (OSError, ValueError) as error:
        message = str(error)[:2000]
        result = {
            "schema": 1,
            "engine": "pdflatex",
            "rootFile": root_file,
            "success": False,
            "diagnostics": [{"severity": "error", "message": message}],
            "log": message,
            "versions": {},
        }
        print(message, flush=True)
        code = 1
    record = json.dumps(result, ensure_ascii=False).encode("utf-8")
    if len(record) > 1024 * 1024:
        result["log"] = result["log"][-64000:]
        result["diagnostics"] = result["diagnostics"][:50]
        for diagnostic in result["diagnostics"]:
            diagnostic["message"] = diagnostic["message"][:1000]
        record = json.dumps(result, ensure_ascii=False).encode("utf-8")
    write_output("result.json", record)
    artifacts = {}
    for name, limit in [
        ("document.pdf", MAX_PDF_BYTES),
        ("document.txt", MAX_TEXT_BYTES),
        ("result.json", 1024 * 1024),
    ]:
        try:
            with regular_file(OUTPUT / name, limit) as stream:
                artifacts[name] = base64.b64encode(stream.read(limit + 1)).decode(
                    "ascii"
                )
        except FileNotFoundError:
            pass
    print(
        "\nLEANFLOW_TEX_ARTIFACTS:"
        + token
        + ":"
        + json.dumps({"artifacts": artifacts}),
        flush=True,
    )
    return code


if __name__ == "__main__":
    sys.exit(main())
