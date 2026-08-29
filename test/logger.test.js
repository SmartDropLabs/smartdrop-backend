'use strict';

const { redactInfo } = require('../src/services/logRedaction');

function redact(input) {
  // redactInfo mutates in place; clone so each test starts clean.
  return redactInfo(JSON.parse(JSON.stringify(input)));
}

describe('log redaction (#94)', () => {
  test('redacts a sensitive value in a nested object (regression)', () => {
    const out = redact({ webhook: { secret: 'whsec_abcdef0123456789' } });
    expect(out.webhook.secret).toBe('whsec_****');
  });

  test('redacts mixed-case sensitive key names (regression)', () => {
    const out = redact({ ApiKey: 'sk_live_abc', PRIVATEKEY: 'x', TOKEN: 'y' });
    expect(out.ApiKey).toBe('[REDACTED]');
    expect(out.PRIVATEKEY).toBe('[REDACTED]');
    expect(out.TOKEN).toBe('[REDACTED]');
  });

  test('preserves the whsec_**** partial reveal for webhook secrets', () => {
    const out = redact({ secret: 'whsec_abcdef0123456789' });
    expect(out.secret).toBe('whsec_****');
  });

  test('redacts an array of raw secret-shaped strings (not wrapped in an object)', () => {
    const out = redact({
      secrets: ['whsec_zzz1111111111111', 'whsec_zzz2222222222222'],
    });
    expect(out.secrets).toEqual(['whsec_****', 'whsec_****']);
  });

  test('redacts an array of objects with sensitive keys (regression)', () => {
    const out = redact({
      keys: [{ api_key: 'sk_live_xxxxxxxxxxxx' }, { token: 'tops3cret' }],
    });
    expect(out.keys[0].api_key).toBe('[REDACTED]');
    expect(out.keys[1].token).toBe('[REDACTED]');
  });

  test('redacts token=/secret=/key= query params embedded in a URL under a non-sensitive key', () => {
    const out = redact({
      url: 'https://x.com/hook?token=supersecret123&other=1&key=leaky',
    });
    expect(out.url).toContain('token=[REDACTED]');
    expect(out.url).toContain('key=[REDACTED]');
    expect(out.url).toContain('other=1');
    expect(out.url).not.toContain('supersecret123');
    expect(out.url).not.toContain('leaky');
  });

  test('does not redact legitimate, non-sensitive fields (false-positive guard)', () => {
    const out = redact({
      delivery_id: 'del_abc123',
      asset_code: 'XLM',
      price_usd: 0.1234,
      event_type: 'pool.assets_locked',
    });
    expect(out.delivery_id).toBe('del_abc123');
    expect(out.asset_code).toBe('XLM');
    expect(out.price_usd).toBe(0.1234);
    expect(out.event_type).toBe('pool.assets_locked');
  });

  test('redacts an Authorization header value under an authorization key', () => {
    const out = redact({ authorization: 'Bearer sk_live_abcdef123456' });
    expect(out.authorization).toBe('[REDACTED]');
  });
});
