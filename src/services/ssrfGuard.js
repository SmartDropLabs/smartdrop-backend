'use strict';

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const AppError = require('../errors/AppError');

/**
 * Server-side SSRF guard for outbound webhook deliveries.
 *
 * Why this lives at delivery time (not just registration time): a hostname
 * that resolves to a public IP when the webhook is *registered* can be
 * re-pointed at an internal address by the time it is *dispatched* (classic
 * DNS-rebinding). So we re-resolve and re-validate the target on every actual
 * outbound request, and — to close the rebinding window entirely — we pin the
 * connection to the specific public IP we just validated (sending the original
 * hostname as the `Host` header) instead of letting axios re-resolve the name
 * at connect time. `maxRedirects` is forced to 0 so a 30x from the target
 * cannot bounce us onto an unvalidated internal address.
 *
 * Private/blocked ranges covered: IPv4 loopback (127/8), RFC-1918 (10/8,
 * 172.16/12, 192.168/16), link-local (169.254/16), CGNAT (100.64/10),
 * unspecified (0/8), multicast/reserved (224/4+), IPv6 loopback (::1),
 * unspecified (::), unique-local (fc00::/7), link-local (fe80::/10), multicast
 * (ff00::/8), and IPv4-mapped IPv6 (::ffff:a.b.c.d).
 */

function isPrivateIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 10) return true; // RFC-1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // unspecified
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / shared
  if (a >= 224) return true; // multicast + reserved (224/4, 240/4)
  return false;
}

function isPrivateIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  const addr = ip.trim();
  if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) {
    return isPrivateIpv4(addr.slice(7));
  }
  if (net.isIPv4(addr)) return isPrivateIpv4(addr);
  if (net.isIPv6(addr)) return isPrivateIpv6(addr);
  return true;
}

function normalizeHostname(hostname) {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

async function resolveAddresses(hostname) {
  const host = normalizeHostname(hostname);
  if (net.isIP(host)) return [host]; // already an IP literal — no DNS lookup
  const records = await dns.lookup(host, { all: true });
  return records.map((r) => r.address);
}

function assertProtocol(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('INVALID_URL', 'Webhook URL is not a valid URL', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_URL', 'Webhook URL must use http or https', 400);
  }
  return parsed;
}

/**
 * Synchronous, network-free registration-time check. Rejects obviously
 * private targets expressed as a literal IP (covers the common cases without
 * a DNS round-trip). Hostname-based private targets are caught by the
 * delivery-time `assertPublicTarget` below. Returns the URL unchanged.
 */
function assertPublicUrlSync(url) {
  const parsed = assertProtocol(url);
  const host = normalizeHostname(parsed.hostname);
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new AppError(
      'WEBHOOK_TARGET_BLOCKED',
      'Webhook target must not point to a private or internal network address',
      422,
    );
  }
  return url;
}

/**
 * Delivery-time check. Resolves the target (if it's a hostname), rejects any
 * private/internal address, and returns a connection target pinned to a
 * validated public IP plus the original hostname to send as `Host`. Throws
 * AppError('WEBHOOK_TARGET_BLOCKED') when the target is not allowed.
 */
async function assertPublicTarget(url) {
  const parsed = assertProtocol(url);
  const addresses = await resolveAddresses(parsed.hostname);
  if (addresses.length === 0) {
    throw new AppError(
      'WEBHOOK_TARGET_BLOCKED',
      'Webhook target could not be resolved to a public address',
      422,
    );
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new AppError(
        'WEBHOOK_TARGET_BLOCKED',
        'Webhook target must not point to a private or internal network address',
        422,
      );
    }
  }

  const chosen = addresses[0];
  const isV6 = net.isIP(chosen) === 6;
  const pinned = new URL(url);
  pinned.hostname = isV6 ? `[${chosen}]` : chosen;
  const originalHost = parsed.hostname;
  const hostHeader = net.isIP(normalizeHostname(originalHost)) ? null : originalHost;
  return { targetUrl: pinned.toString(), host: hostHeader };
}

module.exports = {
  assertPublicTarget,
  assertPublicUrlSync,
  isPrivateIp,
};
