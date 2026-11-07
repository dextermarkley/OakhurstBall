// Kiosk pairing link: https://<site>/kiosk#pair=<deviceId>.<token>
// The credentials ride in the URL fragment, which browsers never send to the
// server, so they stay out of request and access logs.
const DEVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function pairingUrl(deviceId: string, token: string, origin = window.location.origin): string {
  return `${origin}/kiosk#pair=${deviceId}.${token}`;
}

/** Parse a pairing link (or just its fragment). Returns null if it isn't one. */
export function parsePairing(text: string): { deviceId: string; token: string } | null {
  const m = text.trim().match(/#pair=([^.&\s]+)\.([^&\s]+)$/);
  if (!m) return null;
  const [, deviceId, token] = m;
  return DEVICE_RE.test(deviceId) && TOKEN_RE.test(token) ? { deviceId, token } : null;
}

export function savePairing(p: { deviceId: string; token: string }) {
  localStorage.setItem('kioskDevice', p.deviceId);
  localStorage.setItem('kioskToken', p.token);
}

export function clearPairing() {
  localStorage.removeItem('kioskDevice');
  localStorage.removeItem('kioskToken');
}
