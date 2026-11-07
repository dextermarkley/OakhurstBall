// Pairing-link round trip. Run: npm test (frontend)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pairingUrl, parsePairing } from '../dist-test/pairing.mjs';

// Same shape the backend issues: randomBytes(24).toString('base64url') → 32 chars.
const token = randomBytes(24).toString('base64url');

test('a generated pairing URL parses back to the same credentials', () => {
  const url = pairingUrl('court-ipad-1', token, 'https://oakhurst-ball.org');
  assert.equal(url, `https://oakhurst-ball.org/kiosk#pair=court-ipad-1.${token}`);
  assert.deepEqual(parsePairing(url), { deviceId: 'court-ipad-1', token });
});

test('works on the bare fragment (window.location.hash)', () => {
  assert.deepEqual(parsePairing(`#pair=ipad_2.${token}`), { deviceId: 'ipad_2', token });
});

test('many random tokens round-trip (base64url may contain - and _)', () => {
  for (let i = 0; i < 500; i++) {
    const t = randomBytes(24).toString('base64url');
    assert.deepEqual(parsePairing(pairingUrl('dev-1', t, 'https://x.org')), { deviceId: 'dev-1', token: t });
  }
});

test('rejects things that are not pairing codes', () => {
  for (const bad of [
    'https://oakhurst-ball.org/kiosk',
    'https://example.com/pay?x=1',
    '#pair=',
    `#pair=.${token}`,
    '#pair=dev.short',
    `#pair=bad id.${token}`,
    `#pair=-dev.${token}`,
    `#pair=dev.${token}<script>`,
    'random text from some other QR code',
  ]) {
    assert.equal(parsePairing(bad), null, bad);
  }
});
