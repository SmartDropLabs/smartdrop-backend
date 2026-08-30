'use strict';

const http = require('http');
const signature = require('../src/services/webhookSignature');
const { buildSignatureHeaders, sendSignedRequest } = require('../src/services/webhook');

const MAX_AGE_MS = 300 * 1000;

// A fixed instant to sign/verify against, so every freshness assertion is
// exact rather than "whatever the clock did between the two calls".
const NOW = 1_700_000_000_000;

function freezeClock(at = NOW) {
  return jest.spyOn(Date, 'now').mockReturnValue(at);
}

describe('webhook signature', () => {
  const secret = 'whsec_test_supersecret_value';
  const body = JSON.stringify({ event: 'pool.assets_locked', amount: 42 });

  test('sign produces a sha256= prefixed hex string', () => {
    const sig = signature.sign(secret, body, NOW);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test('sign binds the timestamp into the MAC', () => {
    // The whole point of #97: the same body signed a second apart must not
    // produce the same signature, or the timestamp is decorative and a
    // captured delivery can simply be re-dated.
    expect(signature.sign(secret, body, NOW)).not.toBe(signature.sign(secret, body, NOW + 1000));
  });

  test('verify returns true for a signature checked at the moment it was signed', () => {
    const clock = freezeClock();
    try {
      expect(signature.verify(secret, body, signature.sign(secret, body, NOW), NOW)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false when body is tampered', () => {
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      expect(signature.verify(secret, body.replace('42', '43'), sig, NOW)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false when signature is tampered', () => {
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      const tampered = sig.replace(/.$/, sig.endsWith('a') ? 'b' : 'a');
      expect(signature.verify(secret, body, tampered, NOW)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false when signature lacks the prefix', () => {
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW).replace('sha256=', '');
      expect(signature.verify(secret, body, sig, NOW)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false for a wrong secret', () => {
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      expect(signature.verify('other_secret_value', body, sig, NOW)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false when the timestamp is re-dated after signing', () => {
    // Presenting a valid signature alongside a different (still fresh)
    // timestamp must fail — otherwise a captured delivery could be kept
    // alive indefinitely by simply advancing the header.
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      expect(signature.verify(secret, body, sig, NOW + 1000)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false once the signature is older than the replay window', () => {
    const signedAt = NOW;
    const sig = signature.sign(secret, body, signedAt);
    const clock = freezeClock(signedAt + MAX_AGE_MS + 1000);
    try {
      expect(signature.verify(secret, body, sig, signedAt)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify returns false for a timestamp dated into the future', () => {
    // The skew check is symmetric. A one-directional `now - ts > maxAge`
    // check would accept this, handing the holder a signature that never
    // expires.
    const signedAt = NOW + MAX_AGE_MS + 1000;
    const sig = signature.sign(secret, body, signedAt);
    const clock = freezeClock(NOW);
    try {
      expect(signature.verify(secret, body, sig, signedAt)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('the replay window is inclusive at its edge in both directions', () => {
    // Pins the comparison as `> maxAge` rather than `>=`, and pins it
    // symmetrically, so an off-by-one cannot silently widen or narrow the
    // window in either direction.
    const clock = freezeClock();
    try {
      const at = (offset) => {
        const sig = signature.sign(secret, body, NOW + offset);
        return signature.verify(secret, body, sig, NOW + offset);
      };
      expect(at(-MAX_AGE_MS)).toBe(true);
      expect(at(-MAX_AGE_MS - 1)).toBe(false);
      expect(at(MAX_AGE_MS)).toBe(true);
      expect(at(MAX_AGE_MS + 1)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('verify rejects malformed timestamps without throwing', () => {
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      // Everything here would survive a naive `Number()` + `isNaN` guard:
      // '', null, [] and false all coerce to 0, and true coerces to 1.
      const malformed = ['', '   ', 'abc', null, undefined, '-1', '12.5', '1e3', '0x10', [], {}, true, false, NaN, Infinity];
      for (const value of malformed) {
        expect(signature.verify(secret, body, sig, value)).toBe(false);
      }
    } finally {
      clock.mockRestore();
    }
  });

  test('verify rejects alternate numeric encodings of a valid instant', () => {
    // Each of these coerces to exactly NOW under `Number()`, so loose
    // parsing would accept them and recompute a matching MAC. A subscriber
    // running the documented verifier builds `${rawHeader}.${body}` from the
    // header *as received*, so it would compute a different MAC and reject.
    // Requiring the timestamp to be the same digits we signed keeps our
    // verifier and the published one from disagreeing.
    const clock = freezeClock();
    try {
      const sig = signature.sign(secret, body, NOW);
      for (const encoding of ['1.7e12', '+1700000000000', '0x18BCFE56800', '1700000000000.0']) {
        expect(Number(encoding)).toBe(NOW);
        expect(signature.verify(secret, body, sig, encoding)).toBe(false);
      }
    } finally {
      clock.mockRestore();
    }
  });

  test('verify honours an explicit maxAgeSeconds override', () => {
    const signedAt = NOW;
    const sig = signature.sign(secret, body, signedAt);
    const clock = freezeClock(signedAt + 600 * 1000);
    try {
      expect(signature.verify(secret, body, sig, signedAt, { maxAgeSeconds: 300 })).toBe(false);
      expect(signature.verify(secret, body, sig, signedAt, { maxAgeSeconds: 900 })).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test('generateSecret produces a whsec_-prefixed token', () => {
    expect(signature.generateSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  test('sign accepts objects by stringifying them', () => {
    const obj = { a: 1, b: 'two' };
    expect(signature.sign(secret, obj, NOW)).toBe(signature.sign(secret, JSON.stringify(obj), NOW));
  });

  test('signatureHeaders emits all three headers from a single resolved timestamp', () => {
    const headers = signature.signatureHeaders(secret, body, NOW);

    expect(headers['X-SmartDrop-Signature']).toBe(signature.sign(secret, body, NOW));
    expect(headers['X-SmartDrop-Timestamp']).toBe(String(NOW));
    expect(headers['X-SmartDrop-Signature-Version']).toBe('2');
  });

  test('signatureHeaders defaults to a timestamp its own signature agrees with', () => {
    // Guards the mismatch this helper exists to prevent: signing with one
    // clock reading and stamping the header from a second one.
    const headers = signature.signatureHeaders(secret, body);
    expect(
      signature.verify(secret, body, headers['X-SmartDrop-Signature'], headers['X-SmartDrop-Timestamp'])
    ).toBe(true);
  });
});

describe('webhook alert deliveries share the one signing scheme', () => {
  const secret = 'whsec_testsecret';

  test('buildSignatureHeaders produces headers the canonical verifier accepts', () => {
    // Cross-module agreement: the alert path (webhook.js) and the canonical
    // module must not drift apart again. This fails if webhook.js ever
    // regrows its own HMAC.
    const payload = { event: 'airdrop.completed', airdrop_id: 'drop-1' };
    const headers = buildSignatureHeaders(secret, payload, NOW);
    const clock = freezeClock();
    try {
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-SmartDrop-Signature-Version']).toBe('2');
      expect(
        signature.verify(secret, payload, headers['X-SmartDrop-Signature'], headers['X-SmartDrop-Timestamp'])
      ).toBe(true);
      expect(
        signature.verify('wrong_secret', payload, headers['X-SmartDrop-Signature'], headers['X-SmartDrop-Timestamp'])
      ).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  test('mock HTTP server receives a signed request that verifies off the wire', async () => {
    let captured = null;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        captured = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        res.statusCode = 204;
        res.end();
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const payload = { event: 'ping', timestamp: '2026-06-25T00:00:00.000Z' };
      const result = await sendSignedRequest(`http://127.0.0.1:${port}/hook`, 'whsec_testsecret', payload);

      expect(result).toMatchObject({ ok: true, status: 204 });
      expect(captured.headers['x-smartdrop-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(captured.headers['x-smartdrop-timestamp']).toMatch(/^\d+$/);
      expect(captured.headers['x-smartdrop-signature-version']).toBe('2');
      // Verified against the RAW bytes that arrived, not a re-stringified
      // object — the same thing a subscriber does.
      expect(signature.verify(
        'whsec_testsecret',
        captured.body,
        captured.headers['x-smartdrop-signature'],
        captured.headers['x-smartdrop-timestamp']
      )).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the README's documented verifier", () => {
  const secret = 'whsec_readme_example_secret';
  const rawBody = JSON.stringify({ event: 'pool.assets_locked', data: { pool_id: 'p1' } });

  // Extracted from README.md rather than copied into this file: a copy would
  // let the published snippet rot silently, which is the exact failure this
  // test exists to prevent. Subscribers paste this code; it has to work.
  function loadDocumentedVerifier() {
    const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
    const section = readme.split('### Verifying the signature (Node.js)')[1];
    expect(section).toBeDefined();
    const snippet = section.match(/```js\n([\s\S]*?)```/);
    expect(snippet).not.toBeNull();
    // eslint-disable-next-line no-new-func
    return new Function('require', `${snippet[1]}\nreturn verifySmartDrop;`)(require);
  }

  function requestFrom(headers, body) {
    return { rawBody: body, header: (name) => headers[name] };
  }

  test('accepts a delivery signed by this codebase', () => {
    const verifySmartDrop = loadDocumentedVerifier();
    const headers = signature.signatureHeaders(secret, rawBody);

    expect(verifySmartDrop(requestFrom(headers, rawBody), secret)).toBe(true);
  });

  test('rejects a tampered body, a wrong secret, and a re-dated timestamp', () => {
    const verifySmartDrop = loadDocumentedVerifier();
    const headers = signature.signatureHeaders(secret, rawBody);

    expect(verifySmartDrop(requestFrom(headers, rawBody.replace('p1', 'p2')), secret)).toBe(false);
    expect(verifySmartDrop(requestFrom(headers, rawBody), 'whsec_wrong')).toBe(false);
    expect(verifySmartDrop(
      requestFrom({ ...headers, 'X-SmartDrop-Timestamp': String(Number(headers['X-SmartDrop-Timestamp']) + 1) }, rawBody),
      secret
    )).toBe(false);
  });

  test('closes the replay window in both directions, like the implementation', () => {
    const verifySmartDrop = loadDocumentedVerifier();
    const clock = freezeClock();
    try {
      const check = (offset) => {
        const headers = signature.signatureHeaders(secret, rawBody, NOW + offset);
        const documented = verifySmartDrop(requestFrom(headers, rawBody), secret);
        // The published verifier and this codebase must agree on every
        // verdict, or subscribers reject deliveries we consider valid.
        expect(documented).toBe(
          signature.verify(secret, rawBody, headers['X-SmartDrop-Signature'], headers['X-SmartDrop-Timestamp'])
        );
        return documented;
      };
      expect(check(0)).toBe(true);
      expect(check(-MAX_AGE_MS)).toBe(true);
      expect(check(-MAX_AGE_MS - 1)).toBe(false);   // stale
      expect(check(MAX_AGE_MS)).toBe(true);
      expect(check(MAX_AGE_MS + 1)).toBe(false);    // future-dated
    } finally {
      clock.mockRestore();
    }
  });

  test('rejects malformed timestamps without throwing', () => {
    const verifySmartDrop = loadDocumentedVerifier();
    const headers = signature.signatureHeaders(secret, rawBody);

    for (const value of ['', '   ', 'abc', undefined, '-1', '12.5', '1.7e12', '+1700000000000']) {
      expect(verifySmartDrop(requestFrom({ ...headers, 'X-SmartDrop-Timestamp': value }, rawBody), secret)).toBe(false);
    }
  });
});
