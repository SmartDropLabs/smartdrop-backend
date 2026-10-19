'use strict';

const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

function getCertificatePins() {
  const raw = process.env.SSL_PINNED_CERTS || '';
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:/g, ''))
    .filter(Boolean);
}

function getSPKIPins() {
  const raw = process.env.SSL_PINNED_SPKI || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function computeSPKIHash(cert) {
  if (!cert) return null;
  try {
    const publicKey = cert.pubkey || cert.raw;
    if (!publicKey) return null;
    return crypto.createHash('sha256').update(publicKey).digest('base64');
  } catch {
    return null;
  }
}

function validateCertificate(socket, hostname) {
  const cert = socket.getPeerCertificate();
  const pinnedCerts = getCertificatePins();
  const pinnedSPKI = getSPKIPins();

  if (pinnedCerts.length === 0 && pinnedSPKI.length === 0) {
    return true;
  }

  if (!cert || Object.keys(cert).length === 0) {
    throw new Error(`SSL pinning: no peer certificate presented for ${hostname}`);
  }

  if (pinnedCerts.length > 0) {
    const fingerprint = (cert.fingerprint256 || '').toLowerCase().replace(/:/g, '');
    if (!pinnedCerts.includes(fingerprint)) {
      throw new Error(`SSL pinning: certificate fingerprint mismatch for ${hostname}`);
    }
  }

  if (pinnedSPKI.length > 0) {
    const spkiHash = computeSPKIHash(cert);
    if (!spkiHash || !pinnedSPKI.includes(spkiHash)) {
      throw new Error(`SSL pinning: SPKI pin mismatch for ${hostname}`);
    }
  }

  return true;
}

function createPinnedAgent(options = {}) {
  return new https.Agent({
    ...options,
    checkServerIdentity(hostname, cert) {
      const defaultCheck = tls.checkServerIdentity(hostname, cert);
      if (defaultCheck) return defaultCheck;

      try {
        validateCertificate({ getPeerCertificate: () => cert }, hostname);
      } catch (err) {
        return err;
      }
      return undefined;
    },
  });
}

let cachedAgent = null;

function getPinnedAgent() {
  if (!cachedAgent) {
    cachedAgent = createPinnedAgent();
  }
  return cachedAgent;
}

function resetPinnedAgent() {
  cachedAgent = null;
}

module.exports = {
  createPinnedAgent,
  getPinnedAgent,
  resetPinnedAgent,
  getCertificatePins,
  getSPKIPins,
};
