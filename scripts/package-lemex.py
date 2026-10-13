#!/usr/bin/env python3
"""Copy a verified native Lemex installation without host credentials or state."""
import argparse
import hashlib
import json
import mmap
import subprocess
from pathlib import Path
import shutil
import tomllib

parser = argparse.ArgumentParser()
parser.add_argument('--source', default=str(Path.home() / '.local/lib/lemex'))
parser.add_argument('--config', default=str(Path.home() / '.lemex/config.toml'))
parser.add_argument('--destination', default='.runtime/lemex')
parser.add_argument('--expected-commit', default='2f0e12c10d0baf7404a83da3b8cb8f04b77822c9')
parser.add_argument('--source-checkout', default=str(Path.home() / 'lemex-fork'), help='Clean checkout used to verify an existing native build when installer metadata is absent')
parser.add_argument('--build-artifacts', default=str(Path.home() / '.cache/lemex-native-build/dev-small'), help='Existing Cargo profile artifact directory; never rebuilt or modified')
args = parser.parse_args()
source = Path(args.source).resolve()
target = Path(args.destination).resolve()
def sha256_file(filename):
    digest = hashlib.sha256()
    with filename.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

metadata = source / 'lemex-install.json'
if metadata.is_file():
    provenance = json.loads(metadata.read_text())
else:
    # Some upstream source installers omit installation metadata. Recover only
    # from explicit source/artifact evidence; never restamp an older binary.
    checkout = Path(args.source_checkout).resolve()
    artifacts = Path(args.build_artifacts).resolve()
    def git(*arguments):
        return subprocess.check_output(['git', '-C', str(checkout), *arguments], text=True).strip()
    if git('rev-parse', 'HEAD') != args.expected_commit or git('status', '--porcelain'):
        raise SystemExit('A clean source checkout at the exact requested commit is required')
    hashes = {}
    for binary in ['lemex', 'lemex-code-mode-host']:
        installed = source / 'bin' / binary
        built = artifacts / binary
        if not installed.is_file() or not built.is_file():
            raise SystemExit('Missing native Cargo artifact; supply --source-checkout and --build-artifacts')
        hashes[binary] = sha256_file(installed)
        if hashes[binary] != sha256_file(built):
            raise SystemExit(f'Installed {binary} does not match the supplied Cargo build artifact')
    with (source / 'bin/lemex').open('rb') as stream:
        with mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as binary:
            if binary.find(args.expected_commit.encode('ascii')) == -1:
                raise SystemExit('Native CLI does not contain the expected compiled Git commit stamp')
    if artifacts.name not in ['release', 'dev-small']:
        raise SystemExit('Expected a release or dev-small Cargo profile directory')
    provenance = {
        'source_commit': args.expected_commit,
        'native_build_commit': args.expected_commit,
        'build_profile': artifacts.name,
        'source_tree': git('rev-parse', args.expected_commit + '^{tree}'),
        'rust_tree': git('rev-parse', args.expected_commit + ':codex-rs'),
        'provenance_verification': 'embedded_cli_commit_and_matching_existing_cargo_artifacts',
        'native_artifact_sha256': hashes,
    }
if provenance.get('source_commit') != args.expected_commit or provenance.get('native_build_commit') != args.expected_commit:
    raise SystemExit('Native installation provenance does not match the requested source commit')
with (source / 'bin/lemex').open('rb') as stream:
    native_magic = stream.read(4)
if native_magic != b'\x7fELF':
    raise SystemExit('Expected the native ELF runtime, not an npm launcher')
expected_native_hashes = provenance.get('native_artifact_sha256') or {name: sha256_file(source / 'bin' / name) for name in ['lemex', 'lemex-code-mode-host']}
target.mkdir(parents=True, exist_ok=True)
for name in ['bin', 'codex-path', 'codex-resources']:
    shutil.copytree(source / name, target / name, dirs_exist_ok=True)
# Source installers may use umask 077. Docker COPY assigns root ownership, so
# normalize only this owned bundle's executable assets for the worker UID.
for directory in [target, *[entry for entry in target.rglob('*') if entry.is_dir()]]:
    directory.chmod(0o755)
for directory in ['bin', 'codex-path', 'codex-resources']:
    for entry in (target / directory).rglob('*'):
        if entry.is_file():
            entry.chmod(0o755)
for name, expected_hash in expected_native_hashes.items():
    if sha256_file(target / 'bin' / name) != expected_hash:
        raise SystemExit('Native installation changed while packaging; retry once its update has completed')
config_file = Path(args.config)
config = tomllib.loads(config_file.read_text()) if config_file.exists() else {}
# Explicit allowlist; never copy arbitrary provider fields, headers, auth, MCP env,
# host paths, trusted projects, installed hooks, or existing sessions.
allowed_top = ['model_provider', 'model', 'model_reasoning_effort', 'model_context_window', 'model_auto_compact_token_limit']
lines = ['# Sanitized native Lemex runtime defaults. Secrets are passed per process.']
for name in allowed_top:
    if name in config:
        lines.append(f'{name} = {json.dumps(config[name])}')
lines += ['model_catalog_json = "models.json"', 'sandbox_mode = "danger-full-access"', 'approval_policy = "never"', 'web_search = "disabled"', '']
for name, provider in config.get('model_providers', {}).items():
    if not name.replace('_', '').replace('-', '').isalnum():
        continue
    lines.append(f'[model_providers.{name}]')
    for key in ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'supports_websockets', 'supports_standalone_web_search']:
        if key in provider:
            value = provider[key]
            lines.append(f'{key} = {str(value).lower() if isinstance(value, bool) else json.dumps(value)}')
    lines.append('')
lines += ['[mcp_servers.lean]', 'command = "/opt/tools/bin/lean-lsp-mcp"', 'args = ["--lean-project-path", "/workspace"]', '', '[mcp_servers.leanexplore]', 'command = "/opt/tools/bin/lean-explore"', 'args = ["mcp", "serve"]', '']
(target / 'config.toml').write_text('\n'.join(lines))
models = config_file.parent / config.get('model_catalog_json', 'models.json')
if models.is_file():
    # Model catalogs contain metadata only; reject obvious accidental auth data.
    content = models.read_text()
    parsed = json.loads(content)
    def inspect(obj):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key.lower() in ['api_key', 'access_token', 'authorization', 'password', 'secret']:
                    raise SystemExit('Refusing catalog with credential fields')
                inspect(value)
        elif isinstance(obj, list):
            for value in obj:
                inspect(value)
    inspect(parsed)
    (target / 'models.json').write_text(content)
else:
    raise SystemExit('A curated model catalog is required for this runtime')
manifest = {key: provenance[key] for key in ['source_commit', 'native_build_commit', 'build_profile', 'source_tree', 'rust_tree', 'provenance_verification', 'native_artifact_sha256'] if key in provenance}
(target / 'lemex-install.json').write_text(json.dumps(manifest, indent=2) + '\n')
manifest['files'] = {}
for path in sorted(target.rglob('*')):
    if path.is_file() and path.name != 'manifest.json':
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        manifest['files'][str(path.relative_to(target))] = digest.hexdigest()
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Packaged Lemex {args.expected_commit} into {target}; no host auth or session state copied')
