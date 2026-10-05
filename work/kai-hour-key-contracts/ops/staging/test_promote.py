"""Local adversarial tests for the privileged broker; never contact a server."""
import base64
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('staging_promote', Path(__file__).with_name('kai-hour-key-staging-promote.py'))
PROMOTE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROMOTE)


def bundle(entries=None, suffix='v1'):
    if entries is None:
        entries = [(name, f'// runtime {suffix}\n'.encode(), None) for name in sorted(PROMOTE.REQUIRED_FILES)]
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.USTAR_FORMAT) as archive:
        for name, content, kind in entries:
            member = tarfile.TarInfo(name)
            member.mode = 0o644
            if kind is not None:
                member.type = kind
                member.linkname = '../../outside'
            else:
                member.size = len(content)
            archive.addfile(member, io.BytesIO(content) if kind is None else None)
    return output.getvalue()


def request(version='v1', payload=None):
    payload = bundle(suffix=version) if payload is None else payload
    return {'op': 'deploy', 'version': version, 'digest': hashlib.sha256(payload).hexdigest(),
            'bundleBase64': base64.b64encode(payload).decode('ascii')}


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='kai-broker-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('state', 'audit', 'releases'):
            (self.root / name).mkdir()
        actions = patch.object(PROMOTE, 'service_action')
        health = patch.object(PROMOTE, 'runtime_identity', side_effect=lambda expected: {'status': 'ok', **expected})
        self.addCleanup(actions.stop)
        self.addCleanup(health.stop)
        self.actions = actions.start()
        self.health = health.start()

    def handle(self, value):
        return PROMOTE.handle(self.root, value)

    def assert_code(self, code, operation):
        with self.assertRaises(PROMOTE.PromotionError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def events(self):
        return [json.loads(line) for line in (self.root / 'audit/events.jsonl').read_text().splitlines()]

    def test_first_and_second_release_keep_exact_artifacts(self):
        first, second = request('v1'), request('v2')
        self.assertEqual(self.handle(first), {'status': 'activated', 'version': 'v1', 'digest': first['digest']})
        self.assertEqual(self.handle(second), {'status': 'activated', 'version': 'v2', 'digest': second['digest']})
        self.assertEqual(PROMOTE.read_link(self.root, 'current'), 'v2')
        self.assertEqual(PROMOTE.read_link(self.root, 'previous'), 'v1')
        self.assertEqual(PROMOTE.release_identity(self.root, 'v1'), {'version': 'v1', 'digest': first['digest']})
        self.assertFalse((self.root / 'state/pending.json').exists())

    def test_failed_candidate_restores_verified_previous_identity(self):
        first, second = request('v1'), request('v2')
        self.handle(first)

        def fail_candidate(expected):
            if expected['version'] == 'v2':
                raise PROMOTE.PromotionError('STAGING_HEALTHCHECK_FAILED')
            return {'status': 'ok', **expected}

        self.health.side_effect = fail_candidate
        result = self.handle(second)
        self.assertEqual(result, {'status': 'rolled_back', 'version': 'v1', 'digest': first['digest'],
                                  'reason': 'STAGING_HEALTHCHECK_FAILED', 'restorationVerified': True})
        self.assertEqual(self.health.call_args.args[0], {'version': 'v1', 'digest': first['digest']})
        self.assertEqual(PROMOTE.read_link(self.root, 'current'), 'v1')
        self.assertIsNone(PROMOTE.read_link(self.root, 'previous'))
        self.assertFalse((self.root / 'state/pending.json').exists())
        self.assertEqual(self.events()[-1]['digest'], first['digest'])

    def test_first_release_failure_stops_service_and_never_claims_rollback(self):
        self.health.side_effect = PROMOTE.PromotionError('STAGING_HEALTHCHECK_FAILED')
        result = self.handle(request())
        self.assertEqual(result['status'], 'needs_attention')
        self.assertFalse(result['restorationVerified'])
        self.assertNotIn('version', result)
        self.assertIsNone(PROMOTE.read_link(self.root, 'current'))
        self.assertIsNone(PROMOTE.read_link(self.root, 'previous'))
        self.actions.assert_called_with('stop')
        self.assertFalse((self.root / 'state/pending.json').exists())

    def test_replay_preserves_previous_without_restart_or_duplicate_audit(self):
        first, second = request('v1'), request('v2')
        self.handle(first)
        self.handle(second)
        before = self.events()
        self.actions.reset_mock()
        result = self.handle(second)
        self.assertTrue(result['replayed'])
        self.assertEqual(PROMOTE.read_link(self.root, 'previous'), 'v1')
        self.actions.assert_not_called()
        self.assertEqual(self.events(), before)

    def test_explicit_rollback_restores_exact_previous_digest(self):
        first, second = request('v1'), request('v2')
        self.handle(first)
        self.handle(second)
        result = self.handle({'op': 'rollback'})
        self.assertEqual(result, {'status': 'rolled_back', 'version': 'v1', 'digest': first['digest']})
        self.assertEqual(PROMOTE.read_link(self.root, 'previous'), 'v2')
        self.assertEqual(self.health.call_args.args[0], {'version': 'v1', 'digest': first['digest']})

    def test_failed_explicit_rollback_restores_original_current_and_reports_attention(self):
        first, second = request('v1'), request('v2')
        self.handle(first)
        self.handle(second)

        def reject_previous(expected):
            if expected['version'] == 'v1':
                raise PROMOTE.PromotionError('STAGING_HEALTHCHECK_FAILED')
            return {'status': 'ok', **expected}

        self.health.side_effect = reject_previous
        result = self.handle({'op': 'rollback'})
        self.assertEqual(result['status'], 'needs_attention')
        self.assertEqual(result['version'], 'v2')
        self.assertEqual(result['digest'], second['digest'])
        self.assertTrue(result['restorationVerified'])
        self.assertEqual(PROMOTE.read_link(self.root, 'current'), 'v2')
        self.assertEqual(PROMOTE.read_link(self.root, 'previous'), 'v1')

    def test_failed_restoration_retains_pending_recovery_record(self):
        self.handle(request('v1'))
        self.health.side_effect = [None, PROMOTE.PromotionError('CANDIDATE_FAILED'), PROMOTE.PromotionError('RESTORATION_FAILED')]
        result = self.handle(request('v2'))
        self.assertEqual(result, {'status': 'needs_attention', 'reason': 'RESTORATION_FAILED',
                                  'failedReason': 'CANDIDATE_FAILED', 'restorationVerified': False})
        self.assertTrue((self.root / 'state/pending.json').exists())

    def test_pending_recovery_restores_slots_before_status(self):
        first = request('v1')
        self.handle(first)
        second = request('v2')
        PROMOTE.extract_bundle(self.root, second, PROMOTE.validate_request(second))
        PROMOTE.write_json(self.root / 'state/pending.json', {'current': 'v1', 'previous': None, 'candidate': 'v2', 'operation': 'deploy'})
        PROMOTE.atomic_link(self.root, 'current', 'v2')
        result = self.handle({'op': 'status'})
        self.assertEqual(result['version'], 'v1')
        self.assertEqual(result['digest'], first['digest'])
        self.assertTrue(result['sharedProductionHost'])
        self.assertFalse((self.root / 'state/pending.json').exists())
        self.assertEqual(self.events()[-1]['operation'], 'interrupted_release_recovery')

    def test_status_and_rollback_without_a_release_are_explicit(self):
        self.assertEqual(self.handle({'op': 'status'}), {'status': 'needs_attention', 'reason': 'STAGING_NOT_ACTIVE'})
        self.assert_code('STAGING_PREVIOUS_NOT_FOUND', lambda: self.handle({'op': 'rollback'}))

    def test_conflicting_version_and_tampering_are_rejected(self):
        first = request('v1')
        self.handle(first)
        self.assert_code('STAGING_ARTIFACT_CONFLICT', lambda: self.handle(request('v1', bundle(suffix='altered'))))
        path = self.root / 'releases/v1/src/staging-service.mjs'
        path.chmod(0o644)
        path.write_text('changed')
        self.assert_code('STAGING_RELEASE_DIGEST_MISMATCH', lambda: self.handle({'op': 'status'}))

    def test_unsafe_current_link_is_rejected(self):
        (self.root / 'current').symlink_to('../../outside')
        self.assert_code('STAGING_LINK_INVALID', lambda: self.handle({'op': 'status'}))

    def test_release_file_symlink_is_rejected(self):
        self.handle(request())
        path = self.root / 'releases/v1/src/staging-service.mjs'
        path.unlink()
        path.symlink_to('/etc/passwd')
        self.assert_code('STAGING_RELEASE_INVALID', lambda: self.handle({'op': 'status'}))

    def test_concurrent_operation_is_rejected_before_switching(self):
        import fcntl
        with (self.root / 'state/deploy.lock').open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_code('STAGING_BUSY', lambda: self.handle(request()))
        self.assertIsNone(PROMOTE.read_link(self.root, 'current'))


class InputTests(unittest.TestCase):
    def assert_code(self, code, operation):
        with self.assertRaises(PROMOTE.PromotionError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def test_valid_envelope_returns_digest_checked_bytes(self):
        payload = bundle()
        self.assertEqual(PROMOTE.validate_request(request(payload=payload)), payload)
        self.assertIsNone(PROMOTE.validate_request({'op': 'status'}))

    def test_invalid_envelopes_and_identifiers_are_rejected(self):
        invalid = [None, [], {}, {'op': 'status', 'extra': True}, {'op': 'rollback', 'version': 'v1'},
                   {'op': 'shell'}, {**request(), 'path': '/tmp/input'}]
        invalid += [{**request(), 'version': value} for value in ('.', '..', '../v1', '/tmp/a', 'x' * 129, 'é', '')]
        invalid += [{**request(), 'digest': value} for value in ('a' * 63, 'G' * 64, 'A' * 64, None)]
        invalid += [{**request(), 'bundleBase64': value} for value in (None, 1, [])]
        for value in invalid:
            with self.subTest(value=value):
                self.assert_code('STAGING_REQUEST_INVALID', lambda: PROMOTE.validate_request(value))

    def test_invalid_base64_size_and_digest_are_rejected(self):
        self.assert_code('STAGING_BUNDLE_INVALID', lambda: PROMOTE.validate_request({**request(), 'bundleBase64': '!'}))
        self.assert_code('STAGING_BUNDLE_TOO_LARGE', lambda: PROMOTE.validate_request(request(payload=b'')))
        self.assert_code('STAGING_BUNDLE_DIGEST_MISMATCH', lambda: PROMOTE.validate_request({**request(), 'digest': '0' * 64}))
        with patch.object(PROMOTE, 'MAX_BUNDLE_BYTES', 4):
            self.assert_code('STAGING_BUNDLE_TOO_LARGE', lambda: PROMOTE.validate_request(request(payload=b'12345')))

    def test_archive_traversal_absolute_unknown_duplicate_and_missing_are_rejected(self):
        entries = [(name, b'x', None) for name in sorted(PROMOTE.REQUIRED_FILES)]
        for name in ('../escape', '/etc/passwd', 'src/../../escape', 'src\\evil', './src/staging-service.mjs', 'extra.txt'):
            with self.subTest(name=name):
                self.assert_code('STAGING_ARCHIVE_FILE_INVALID', lambda: PROMOTE.unpack(bundle([(name, b'x', None)])))
        self.assert_code('STAGING_ARCHIVE_FILE_INVALID', lambda: PROMOTE.unpack(bundle(entries + [entries[0]])))
        self.assert_code('STAGING_ARCHIVE_FILES_MISSING', lambda: PROMOTE.unpack(bundle(entries[:1])))

    def test_archive_symlink_hardlink_and_device_are_rejected(self):
        name = sorted(PROMOTE.REQUIRED_FILES)[0]
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.DIRTYPE):
            with self.subTest(kind=kind):
                self.assert_code('STAGING_ARCHIVE_MEMBER_INVALID', lambda: PROMOTE.unpack(bundle([(name, b'', kind)])))

    def test_archive_permission_bits_are_rejected(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            member = tarfile.TarInfo('src/staging-service.mjs')
            member.mode = 0o4755
            archive.addfile(member, io.BytesIO())
        self.assert_code('STAGING_ARCHIVE_MEMBER_INVALID', lambda: PROMOTE.unpack(output.getvalue()))

    def test_decompressed_size_is_bounded_before_tar_parsing(self):
        compressed = gzip.compress(b'\0' * (PROMOTE.MAX_EXTRACTED_BYTES + 1))
        self.assertLess(len(compressed), 8192)
        self.assert_code('STAGING_ARCHIVE_TOO_LARGE', lambda: PROMOTE.unpack(compressed))
        self.assert_code('STAGING_ARCHIVE_INVALID', lambda: PROMOTE.unpack(b'not gzip'))

    def test_cli_rejects_arguments_and_non_root_before_reading_stdin(self):
        with patch.object(PROMOTE.sys, 'argv', ['helper', '--test-root', '/tmp/evil']), patch.object(PROMOTE.os, 'geteuid', return_value=0):
            self.assert_code('STAGING_ARGUMENTS_INVALID', PROMOTE.main)
        with patch.object(PROMOTE.sys, 'argv', ['helper']), patch.object(PROMOTE.os, 'geteuid', return_value=1000):
            self.assert_code('STAGING_ARGUMENTS_INVALID', PROMOTE.main)

    def test_service_failures_are_controlled(self):
        for error in (subprocess.TimeoutExpired('systemctl', 20), subprocess.CalledProcessError(1, 'systemctl'), OSError('systemctl unavailable')):
            with self.subTest(error=type(error).__name__), patch.object(PROMOTE.subprocess, 'run', side_effect=error):
                self.assert_code('STAGING_SERVICE_ACTION_FAILED', lambda: PROMOTE.service_action('restart'))

    def test_health_validation_requires_exact_expected_identity(self):
        expected = {'version': 'v1', 'digest': 'a' * 64}
        class Reply:
            def __init__(self, body):
                self.body = body
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return None
            def read(self, maximum):
                return self.body[:maximum]
        class Opener:
            def __init__(self, health, version):
                self.health, self.version = health, version
            def open(self, url, timeout):
                return Reply(self.health if url.endswith('/healthz') else self.version)
        good_health = json.dumps({'status': 'ok', **expected}).encode()
        good_version = json.dumps(expected).encode()
        with patch.object(PROMOTE, 'build_opener', return_value=Opener(good_health, good_version)):
            self.assertEqual(PROMOTE.runtime_identity(expected), {'status': 'ok', **expected})
        cases = [(b'x' * 4097, good_version),
                 (json.dumps({'status': 'ok', 'version': 'other', 'digest': 'b' * 64}).encode(), good_version),
                 (good_health, json.dumps({**expected, 'extra': 'untrusted'}).encode())]
        for health, version in cases:
            with self.subTest(health=health[:50]), patch.object(PROMOTE, 'build_opener', return_value=Opener(health, version)), patch.object(PROMOTE.time, 'monotonic', side_effect=[0, 0, 9]), patch.object(PROMOTE.time, 'sleep'):
                self.assert_code('STAGING_HEALTHCHECK_FAILED', lambda: PROMOTE.runtime_identity(expected))


if __name__ == '__main__':
    unittest.main()
