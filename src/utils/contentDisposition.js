'use strict';

/**
 * Safe Content-Disposition header generation for file downloads (Issue #499).
 *
 * Prevents:
 * 1. CRLF response header injection / HTTP response splitting.
 * 2. Directory path traversal (../../etc/passwd).
 * 3. File type sniffing by setting nosniff and noopen.
 */

/**
 * Formats a RFC 6266 and RFC 5987 compliant Content-Disposition header value.
 *
 * @param {string} filename - Raw requested filename
 * @param {'attachment'|'inline'} [type='attachment']
 * @returns {string} Safe Content-Disposition header value
 */
function buildSafeContentDisposition(filename, type = 'attachment') {
  if (!filename || typeof filename !== 'string') {
    return `${type}; filename="download"`;
  }

  // 1. Strip CRLF to prevent response splitting / header injection
  let sanitized = filename.replace(/[\r\n\0]/g, '');

  // 2. Strip directory path traversal (e.g. "../../secret.txt" -> "secret.txt")
  sanitized = sanitized.replace(/^.*[\\/]/, '');

  // 3. Fallback if empty after stripping
  if (!sanitized || sanitized.trim() === '') {
    sanitized = 'download';
  }

  // 4. Create an ASCII-safe fallback for older clients
  const asciiFallback = sanitized.replace(/[^A-Za-z0-9._-]/g, '_');

  // 5. UTF-8 encoded filename* per RFC 5987
  const utf8Encoded = encodeURIComponent(sanitized);

  return `${type}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}

/**
 * Sets safe headers for file downloads on an Express response.
 *
 * @param {import('express').Response} res
 * @param {string} filename - Desired filename
 * @param {string} [contentType='application/octet-stream']
 */
function setSafeDownloadHeaders(res, filename, contentType = 'application/octet-stream') {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', buildSafeContentDisposition(filename, 'attachment'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Download-Options', 'noopen');
}

module.exports = {
  buildSafeContentDisposition,
  setSafeDownloadHeaders,
};
