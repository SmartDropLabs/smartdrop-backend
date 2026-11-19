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

/**
 * Blocked ranges (#694). Node's BlockList does the CIDR matching, so each range is one line.
 * IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses are checked by their embedded IPv4 address.
 */
const BLOCKED_IPV4 = new net.BlockList();
[
  ['0.0.0.0', 8], // unspecified / "this network"
  ['10.0.0.0', 8], // RFC-1918
  ['100.64.0.0', 10], // CGNAT / shared
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // RFC-1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC-1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
].forEach(([addr, prefix]) => BLOCKED_IPV4.addSubnet(addr, prefix, 'ipv4'));

const BLOCKED_IPV6 = new net.BlockList();
[
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated), includes ::/128 and ::1
  ['::ffff:0:0', 96], // IPv4-mapped, anything not parsed by embeddedIpv4() is refused
  ['64:ff9b::', 96], // NAT64, anything not parsed by embeddedIpv4() is refused
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local (fe80::/10 covers fe80 through febf)
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
].forEach(([addr, prefix]) => BLOCKED_IPV6.addSubnet(addr, prefix, 'ipv6'));

/** Returns the dotted IPv4 address embedded in an IPv4-mapped or NAT64 IPv6 address, or null. */
function embeddedIpv4(addr) {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (dotted) return dotted[1];
  // The WHATWG URL parser rewrites ::ffff:127.0.0.1 as ::ffff:7f00:1, so the hex form has to be handled too.
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return null;
}

function isPrivateIpv4(ip) {
  if (!net.isIPv4(ip)) return true;
  return BLOCKED_IPV4.check(ip, 'ipv4');
}

function isPrivateIpv6(ip) {
  return BLOCKED_IPV6.check(ip, 'ipv6');
}

function isPrivateIp(ip) {
  if (typeof ip !== 'string') return true;
  const addr = ip.trim().toLowerCase();
  const embedded = embeddedIpv4(addr);
  if (embedded) return isPrivateIpv4(embedded);
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
  return { targetUrl: pinned.toString(), host: hostHeader, pinnedIp: chosen, addresses };
}

/**
 * Pin DNS resolution for a hostname and verify it resolves strictly to public addresses (#627).
 * @param {string} hostname
 * @returns {Promise<string>} Validated public IP address
 */
async function pinDns(hostname) {
  const host = normalizeHostname(hostname);
  const addresses = await resolveAddresses(host);
  if (!addresses || addresses.length === 0) {
    throw new AppError('WEBHOOK_TARGET_BLOCKED', 'Webhook target could not be resolved to a public address', 422);
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
  return addresses[0];
}

module.exports = {
  assertPublicTarget,
  assertPublicUrlSync,
  isPrivateIp,
  pinDns,
  resolveAddresses,
};
