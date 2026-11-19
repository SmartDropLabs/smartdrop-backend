'use strict';

/**
 * Versioned email template registry (#679).
 *
 * Each template name owns an ordered set of immutable versions. A queued email
 * can record the version it was rendered with (queueEmail's templateVersion),
 * so a bad template can be traced and rolled back by re-rendering the previous
 * version.
 */

/** @type {Map<string, Map<number, Readonly<Object>>>} */
const registry = new Map();

/**
 * Register one version of a named email template. Versions are immutable:
 * registering an existing name+version throws.
 *
 * @param {string} name - Template name, e.g. 'airdropConfirmation'
 * @param {number} version - Positive integer version
 * @param {{subject: string, text?: string, html?: string}} fields - Template fields with {{var}} placeholders
 * @returns {void}
 * @throws {Error} When name, version or fields are invalid, or the version already exists
 */
function registerTemplateVersion(name, version, fields) {
  if (typeof name !== 'string' || !name) {
    throw new Error('registerTemplateVersion requires a non-empty template name');
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `registerTemplateVersion: version for "${name}" must be a positive integer, got ${version}`,
    );
  }
  if (!fields || typeof fields.subject !== 'string') {
    throw new Error(`registerTemplateVersion: "${name}" v${version} requires a subject string`);
  }

  let versions = registry.get(name);
  if (!versions) {
    versions = new Map();
    registry.set(name, versions);
  }
  if (versions.has(version)) {
    throw new Error(
      `registerTemplateVersion: "${name}" v${version} is already registered; template versions are immutable`,
    );
  }
  versions.set(version, Object.freeze({ ...fields }));
}

/**
 * Look up a template version. When version is omitted, the highest registered
 * version (the latest) is returned.
 *
 * @param {string} name - Template name
 * @param {number} [version] - Version to fetch; defaults to the latest
 * @returns {{name: string, version: number, fields: Readonly<Object>}}
 * @throws {Error} When the template is unknown or the requested version does not exist
 */
function getTemplateVersion(name, version) {
  const versions = registry.get(name);
  if (!versions || versions.size === 0) {
    throw new Error(`Unknown email template "${name}"`);
  }

  const resolved = version === undefined ? Math.max(...versions.keys()) : version;
  const fields = versions.get(resolved);
  if (!fields) {
    const available = [...versions.keys()].sort((a, b) => a - b).join(', ');
    throw new Error(
      `Email template "${name}" has no version ${resolved} (available: ${available})`,
    );
  }
  return { name, version: resolved, fields };
}

module.exports = {
  registerTemplateVersion,
  getTemplateVersion,
};
