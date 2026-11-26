"""Pinned, local-only history scan. Never print scanner output or findings."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

VERSION = '8.30.1'
HASHES = {
    'x86_64': ('x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'),
    'aarch64': ('arm64', 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080'),
}
LIMIT = 128 * 1024 * 1024


def safe_env(home):
    # Do not inherit credentials, Git overrides or Gitleaks config from the runner.
    return {'PATH': os.defpath, 'HOME': str(home), 'LC_ALL': 'C',
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
            'GIT_TERMINAL_PROMPT': '0', 'GIT_NO_REPLACE_OBJECTS': '1'}


def command(args, cwd, env, timeout=300):
    return subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, check=False)


def git(args, root, env):
    result = command(['git', '-c', 'core.hooksPath=/dev/null', *args], root, env)
    if result.returncode != 0:
        raise RuntimeError('git verification incomplete')
    return result.stdout.decode('ascii').strip()


def install(directory):
    if platform.system() != 'Linux' or platform.machine() not in HASHES:
        raise RuntimeError('unsupported platform')
    arch, digest = HASHES[platform.machine()]
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_linux_{arch}.tar.gz'
    archive = directory / 'tool.tar.gz'
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT or hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('archive verification failed')
    archive.write_bytes(data)
    binary = directory / 'gitleaks'
    with tarfile.open(archive, 'r:gz') as tar:
        members = [member for member in tar.getmembers() if member.name == 'gitleaks']
        if len(members) != 1 or not members[0].isfile() or members[0].size > LIMIT:
            raise RuntimeError('binary missing or unsafe')
        with tar.extractfile(members[0]) as source:
            binary.write_bytes(source.read(LIMIT + 1))
    binary.chmod(0o700)
    return binary


def scan(root, expected, binary, scratch):
    env = safe_env(scratch)
    if not re.fullmatch('[0-9a-f]{40}', expected or ''):
        raise RuntimeError('expected SHA required')
    if git(['rev-parse', 'HEAD'], root, env) != expected:
        raise RuntimeError('checkout mismatch')
    if git(['rev-parse', '--is-shallow-repository'], root, env) != 'false':
        raise RuntimeError('history incomplete')
    count = int(git(['rev-list', '--count', expected], root, env))
    if count < 1:
        raise RuntimeError('history empty')
    # A bare local copy prevents repository .gitleaksignore and config files from
    # silently weakening built-in rules. No remote fetch, shared objects or hooks.
    snapshot = scratch / 'history.git'
    git(['clone', '--bare', '--no-hardlinks', '--', str(root), str(snapshot)], scratch, env)
    if git(['rev-list', '--count', expected], snapshot, env) != str(count):
        raise RuntimeError('history copy mismatch')
    version = command([str(binary), 'version'], scratch, env, 10)
    if version.returncode != 0 or version.stdout.decode().strip() != VERSION:
        raise RuntimeError('tool version mismatch')
    config = scratch / 'rules.toml'
    config.write_text('[extend]\nuseDefault = true\n')
    report = scratch / 'result.json'
    result = command([str(binary), 'git', str(snapshot), '--log-opts=--full-history -m --no-ext-diff --no-textconv ' + expected,
                      '--config=' + str(config), '--gitleaks-ignore-path=' + str(scratch),
                      '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color',
                      '--exit-code=23', '--timeout=240', '--report-format=json',
                      '--report-path=' + str(report)], scratch, env)
    if result.returncode not in (0, 23) or not report.is_file() or report.stat().st_size > LIMIT:
        raise RuntimeError('scan incomplete')
    findings = json.loads(report.read_text())
    if not isinstance(findings, list) or any(not isinstance(item, dict) for item in findings):
        raise RuntimeError('invalid report')
    if (result.returncode == 0) != (len(findings) == 0):
        raise RuntimeError('inconsistent scan result')
    # No path, finding value, matching line or raw report is emitted.
    print(f'Gitleaks {VERSION}: sha={expected} commits={count} findings={len(findings)}')
    return 1 if findings else 0


def main():
    with tempfile.TemporaryDirectory(prefix='encoding-guard-gitleaks-') as temporary:
        scratch = Path(temporary)
        scratch.chmod(0o700)
        binary = install(scratch)
        return scan(Path(__file__).resolve().parents[1], os.environ.get('GITHUB_SHA'), binary, scratch)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Gitleaks verification incomplete; no findings or raw output disclosed.', file=sys.stderr)
        sys.exit(1)
