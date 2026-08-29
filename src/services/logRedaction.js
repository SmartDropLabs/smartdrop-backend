'use strict';

const winston = require('winston');

/**
 * Log redaction.
 *
 * Winston's JSON formatter already JSON-escapes string values, so the risk
 * here is NOT structurally corrupting log lines. The risks are:
 *   1. Correlation/secret leakage: sensitive values flowing into every log line.
 *   2. Volume: extremely long values (e.g. an oversized X-Request-ID) bloating
 *      every downstream log line.
 *
 * This format redacts two ways:
 *   - Key-based: any object key containing apikey/privatekey/secret/token/
 *     authorization triggers redaction of its value.
 *   - Pattern-based: every string value (regardless of key) is scanned for
 *     webhook secret shapes (`whsec_…`, partially revealed as `whsec_****` for
 *     operator debuggability) and for credentials embedded in URLs
 *     (`?token=…`, `?secret=…`, `?key=…`), which are replaced in place.
 *
 * Arrays are walked as first-class nodes: a plain array of secret-shaped
 * strings (not wrapped in an object) is now redacted, not just arrays of
 * objects with sensitive keys.
 */

const SENSITIVE_KEYS = ['apikey', 'privatekey', 'secret', 'token', 'authorization'];

// Matches webhook secrets (whsec_ + hex). Safe to match broadly: the prefix is
// distinctive and only ever precedes a secret in this codebase.
const WHSEC_RE = /whsec_[0-9a-f]+/gi;

// Matches token=/secret=/key= query parameters embedded in any string value,
// capturing the parameter name so we can preserve it and only redact the value.
const QUERY_SECRET_RE = /([?&](?:token|secret|key)=)([^&#\s]+)/gi;

// Normalize a key for matching: treat `_`/`-` as nothing so `api_key`,
// `ApiKey`, `PRIVATE_KEY` all match their tokens.
function normKey(key) {
  return String(key).toLowerCase().replace(/[_-]/g, '');
}

function isSensitiveKey(key) {
  const n = normKey(key);
  return SENSITIVE_KEYS.some((k) => n.includes(k));
}

function redactWhsec(value) {
  return value.replace(WHSEC_RE, 'whsec_****');
}

function redactQuerySecrets(value) {
  return value.replace(QUERY_SECRET_RE, '$1[REDACTED]');
}

// Scan a string value for secret *shapes* regardless of the key it sits under.
function scanString(value) {
  let out = redactWhsec(value);
  out = redactQuerySecrets(out);
  return out;
}

function redactValue(value, key) {
  if (typeof value !== 'string') return '[REDACTED]';
  if (normKey(key).includes('secret') && value.startsWith('whsec_')) {
    return 'whsec_****';
  }
  return '[REDACTED]';
}

// A sensitive-keyed value may itself be a nested object/array (e.g. `secrets`
// is an array of secret-shaped strings). Recurse into it so each leaf is
// redacted by shape/key rather than blanket-replacing the whole structure with
// `[REDACTED]` — which would also lose the `whsec_****` partial reveal.
function redactSensitiveValue(value, key, seen) {
  if (typeof value === 'string') return redactValue(value, key);
  if (Array.isArray(value)) {
    return value.map((el) => {
      if (typeof el === 'string') return redactValue(el, key);
      if (el && typeof el === 'object') return redact(el, seen);
      return el;
    });
  }
  if (value && typeof value === 'object') return redact(value, seen);
  return '[REDACTED]';
}

function redact(node, seen) {
  if (!node || typeof node !== 'object') return node;
  if (seen.has(node)) return node;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const el = node[i];
      if (typeof el === 'string') {
        node[i] = scanString(el);
      } else if (el && typeof el === 'object') {
        redact(el, seen);
      }
    }
    return node;
  }

  for (const key of Object.keys(node)) {
    const val = node[key];

    if (isSensitiveKey(key)) {
      node[key] = redactSensitiveValue(val, key, seen);
    } else if (typeof val === 'string') {
      node[key] = scanString(val);
    } else if (val && typeof val === 'object') {
      redact(val, seen);
    }
  }
  return node;
}

function redactInfo(info) {
  // Track visited objects to avoid infinite recursion on circular structures.
  return redact(info, new Set());
}

const redactFormat = winston.format(redactInfo);

module.exports = { redactInfo, redactFormat, SENSITIVE_KEYS };
