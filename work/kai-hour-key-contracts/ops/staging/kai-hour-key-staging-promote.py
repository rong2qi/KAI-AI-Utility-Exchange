#!/usr/bin/python3 -I
"""Fixed-purpose root broker. Uploaded code runs only as the sandboxed runtime user."""
import base64
import binascii
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.request import ProxyHandler, build_opener

DEFAULT_ROOT = Path('/opt/kai-hour-key-staging')
UNIT = 'kai-hour-key-staging.service'
PORT = 18971
MAX_INPUT = 12 * 1024 * 1024
MAX_BUNDLE_BYTES = 8 * 1024 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024
REQUIRED_FILES = {'src/staging-service.mjs', 'scripts/staging-service.mjs'}


class PromotionError(Exception):
    def __init__(self, code, message='Staging operation could not be verified'):
        super().__init__(message)
        self.code = code


def safe_version(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', value) is not None


def safe_digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def load_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value, mode=0o600):
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        sync_dir(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def validate_request(request):
    if not isinstance(request, dict):
        raise PromotionError('STAGING_REQUEST_INVALID')
    if request.get('op') in ('status', 'rollback') and set(request) == {'op'}:
        return None
    if set(request) != {'op', 'version', 'digest', 'bundleBase64'} or request.get('op') != 'deploy':
        raise PromotionError('STAGING_REQUEST_INVALID')
    if not safe_version(request['version']) or not safe_digest(request['digest']) or not isinstance(request['bundleBase64'], str):
        raise PromotionError('STAGING_REQUEST_INVALID')
    try:
        payload = base64.b64decode(request['bundleBase64'], validate=True)
    except (ValueError, binascii.Error) as error:
        raise PromotionError('STAGING_BUNDLE_INVALID') from error
    if not 0 < len(payload) <= MAX_BUNDLE_BYTES:
        raise PromotionError('STAGING_BUNDLE_TOO_LARGE')
    if hashlib.sha256(payload).hexdigest() != request['digest']:
        raise PromotionError('STAGING_BUNDLE_DIGEST_MISMATCH')
    return payload


def unpack(payload):
    # Bound decompression before parsing metadata (including PAX headers).
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as stream:
            raw = stream.read(MAX_EXTRACTED_BYTES + 1)
        if len(raw) > MAX_EXTRACTED_BYTES:
            raise PromotionError('STAGING_ARCHIVE_TOO_LARGE')
        files = {}
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
            for member in archive:
                if member.name not in REQUIRED_FILES or member.name in files:
                    raise PromotionError('STAGING_ARCHIVE_FILE_INVALID')
                if not member.isfile() or member.mode & 0o7000 or member.size < 0:
                    raise PromotionError('STAGING_ARCHIVE_MEMBER_INVALID')
                with archive.extractfile(member) as source:
                    files[member.name] = source.read(MAX_EXTRACTED_BYTES + 1)
                if len(files[member.name]) != member.size:
                    raise PromotionError('STAGING_ARCHIVE_FILE_INVALID')
        if set(files) != REQUIRED_FILES:
            raise PromotionError('STAGING_ARCHIVE_FILES_MISSING')
        return files
    except (tarfile.TarError, OSError, EOFError) as error:
        raise PromotionError('STAGING_ARCHIVE_INVALID') from error


def read_link(root, name):
    link = root / name
    if not link.is_symlink():
        if link.exists():
            raise PromotionError('STAGING_LINK_INVALID')
        return None
    value = os.readlink(link)
    version = value.removeprefix('releases/')
    if not safe_version(version) or value != f'releases/{version}':
        raise PromotionError('STAGING_LINK_INVALID')
    return version


def atomic_link(root, name, version):
    link = root / name
    if version is None:
        link.unlink(missing_ok=True)
    else:
        if not safe_version(version):
            raise PromotionError('STAGING_VERSION_INVALID')
        temporary = root / f'.{name}.{os.getpid()}.tmp'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(f'releases/{version}')
        os.replace(temporary, link)
    sync_dir(root)


def release_identity(root, version):
    path = root / 'releases' / version
    if path.is_symlink() or not path.is_dir():
        raise PromotionError('STAGING_RELEASE_INVALID')
    manifest = load_json(path / 'manifest.json')
    if manifest.get('version') != version or not safe_digest(manifest.get('digest')) or set(manifest.get('files', {})) != REQUIRED_FILES:
        raise PromotionError('STAGING_MANIFEST_INVALID')
    for name, digest in manifest['files'].items():
        file = path / name
        if file.is_symlink() or file.parent.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise PromotionError('STAGING_RELEASE_INVALID')
        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise PromotionError('STAGING_RELEASE_DIGEST_MISMATCH')
    return {'version': version, 'digest': manifest['digest']}


def extract_bundle(root, request, payload):
    files = unpack(payload)
    manifest = {'version': request['version'], 'digest': request['digest'],
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    final = root / 'releases' / request['version']
    if final.exists() or final.is_symlink():
        identity = release_identity(root, request['version'])
        if identity['digest'] != request['digest']:
            raise PromotionError('STAGING_ARTIFACT_CONFLICT')
        return
    temporary = Path(tempfile.mkdtemp(prefix='.candidate-', dir=root / 'releases'))
    try:
        for name, data in files.items():
            file = temporary / name
            file.parent.mkdir(mode=0o755, exist_ok=True)
            with file.open('xb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            file.chmod(0o444)
        write_json(temporary / 'manifest.json', manifest, 0o444)
        temporary.chmod(0o755)
        os.replace(temporary, final)
        sync_dir(final.parent)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def service_action(action):
    try:
        subprocess.run(['/usr/bin/systemctl', action, UNIT], check=True, capture_output=True, timeout=20)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise PromotionError('STAGING_SERVICE_ACTION_FAILED') from error


def runtime_identity(expected):
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            bodies = []
            for route in ('healthz', 'version'):
                with opener.open(f'http://127.0.0.1:{PORT}/{route}', timeout=0.5) as response:
                    raw = response.read(4097)
                    if len(raw) > 4096:
                        raise ValueError('oversized health response')
                    bodies.append(json.loads(raw))
            health, version = bodies
            if version == expected and health == {'status': 'ok', **expected}:
                return health
        except (OSError, ValueError):
            pass  # Startup readiness is polled only until the fixed deadline.
        time.sleep(0.2)
    raise PromotionError('STAGING_HEALTHCHECK_FAILED')


def verify(root, version):
    expected = release_identity(root, version)
    runtime_identity(expected)
    return expected


def write_audit(root, result):
    event = {'at': datetime.now(timezone.utc).isoformat(), **result}
    with (root / 'audit' / 'events.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(event, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    write_json(root / 'state' / 'status.json', event)


def apply_release(root, candidate, previous, action):
    current = read_link(root, 'current')
    old_previous = read_link(root, 'previous')
    pending = {'current': current, 'previous': old_previous, 'candidate': candidate, 'operation': action}
    write_json(root / 'state' / 'pending.json', pending)
    atomic_link(root, 'current', candidate)
    try:
        service_action('restart')
        identity = verify(root, candidate)
        atomic_link(root, 'previous', previous)
        result = {'status': 'activated' if action == 'deploy' else 'rolled_back', **identity}
    except PromotionError as error:
        atomic_link(root, 'current', current)
        atomic_link(root, 'previous', old_previous)
        try:
            if current:
                service_action('restart')
                identity = verify(root, current)
                result = {'status': 'rolled_back' if action == 'deploy' else 'needs_attention', **identity,
                          'reason': error.code, 'restorationVerified': True}
            else:
                service_action('stop')
                result = {'status': 'needs_attention', 'reason': error.code, 'restorationVerified': False}
        except PromotionError as restore_error:
            result = {'status': 'needs_attention', 'reason': restore_error.code, 'failedReason': error.code,
                      'restorationVerified': False}
        write_audit(root, {'operation': action, 'candidate': candidate, **result})
        if result['restorationVerified'] or current is None:
            (root / 'state' / 'pending.json').unlink(missing_ok=True)
        return result
    write_audit(root, {'operation': action, 'candidate': candidate, **result})
    (root / 'state' / 'pending.json').unlink(missing_ok=True)
    # No automatic deletion: retain successful slots and failed candidates for review.
    return result


def recover(root):
    pending_path = root / 'state' / 'pending.json'
    if not pending_path.exists():
        return
    pending = load_json(pending_path)
    current = pending['current']
    atomic_link(root, 'current', current)
    atomic_link(root, 'previous', pending['previous'])
    if current:
        service_action('restart')
        identity = verify(root, current)
    else:
        service_action('stop')
        identity = {}
    write_audit(root, {'operation': 'interrupted_release_recovery', 'status': 'rolled_back' if current else 'needs_attention', **identity})
    pending_path.unlink()


def handle(root, request):
    payload = validate_request(request)
    with (root / 'state' / 'deploy.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise PromotionError('STAGING_BUSY') from error
        recover(root)
        op = request['op']
        current = read_link(root, 'current')
        if op == 'status':
            if current is None:
                return {'status': 'needs_attention', 'reason': 'STAGING_NOT_ACTIVE'}
            return {'status': 'activated', **verify(root, current), 'previous': read_link(root, 'previous'),
                    'target': 'kai-hour-key-staging', 'sharedProductionHost': True}
        if op == 'rollback':
            previous = read_link(root, 'previous')
            if not previous:
                raise PromotionError('STAGING_PREVIOUS_NOT_FOUND')
            release_identity(root, previous)
            return apply_release(root, previous, current, op)
        extract_bundle(root, request, payload)
        if current == request['version']:
            return {'status': 'activated', **verify(root, current), 'replayed': True}
        if current:
            verify(root, current)  # Only a verified running release can be the recovery target.
        return apply_release(root, request['version'], current, op)


def assert_root_layout(root):
    for path in (root, root / 'state', root / 'audit', root / 'releases'):
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise PromotionError('STAGING_ROOT_UNSAFE')
    if root.resolve() != root:
        raise PromotionError('STAGING_ROOT_UNSAFE')


def main():
    if len(sys.argv) != 1 or os.geteuid() != 0:
        raise PromotionError('STAGING_ARGUMENTS_INVALID')
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(PromotionError('STAGING_INPUT_TIMEOUT')))
    signal.alarm(15)
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    signal.alarm(0)
    if len(raw) > MAX_INPUT:
        raise PromotionError('STAGING_INPUT_TOO_LARGE')
    try:
        request = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise PromotionError('STAGING_REQUEST_INVALID') from error
    assert_root_layout(DEFAULT_ROOT)
    result = handle(DEFAULT_ROOT, request)
    print(json.dumps(result, sort_keys=True))
    # A recovered failed deployment is still a failed CI deployment.
    return 0 if result['status'] == 'activated' or (request['op'] == 'rollback' and result['status'] == 'rolled_back') else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except PromotionError as error:
        print(json.dumps({'status': 'needs_attention', 'code': error.code}))
        sys.exit(2)
    except Exception:
        print(json.dumps({'status': 'needs_attention', 'code': 'STAGING_INTERNAL_ERROR'}))
        sys.exit(2)
