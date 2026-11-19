'use strict';

const crypto = require('crypto');
const logger = require('../logger');
const config = require('../config');
const cache = require('./cache');

// Scan results are reused for a day, keyed by the file's SHA-256 (#693).
const SCAN_CACHE_TTL_SECONDS = 86400;

/**
 * Virus scanning service for uploaded files (#574).
 *
 * Supports pluggable backends (e.g. ClamAV, YARA, commercial APIs).
 * By default, provides a no-op implementation that logs scan requests.
 * Configure via VIRUS_SCANNER_BACKEND and related env vars.
 */

class VirusScanner {
  constructor(backend = null) {
    this.backend = backend || this._createDefaultBackend();
  }

  _createDefaultBackend() {
    const backendType = config.virusScannerBackend || 'log';

    if (backendType === 'clamav') {
      return this._createClamAvBackend();
    }

    return this._createLogBackend();
  }

  _createLogBackend() {
    return {
      scan: async (buffer, filename) => {
        logger.info('Virus scan requested', { filename, sizeBytes: buffer.length });
        return { infected: false, threats: [] };
      },
    };
  }

  _createClamAvBackend() {
    try {
      const NodeClam = require('clamscan');
      const clamscan = new NodeClam().init({
        clamdscan: {
          host: config.clamavHost || 'localhost',
          port: config.clamavPort || 3310,
        },
      });

      return {
        scan: async (buffer, filename) => {
          try {
            const { isInfected, viruses } = await clamscan.scanBuffer(buffer);
            return { infected: isInfected, threats: viruses || [] };
          } catch (err) {
            logger.error('ClamAV scan failed', { error: err.message, filename });
            throw err;
          }
        },
      };
    } catch (err) {
      logger.warn('ClamAV backend not available, falling back to log backend', {
        error: err.message,
      });
      return this._createLogBackend();
    }
  }

  /** Key covers the backend too, so switching scanners never reuses another scanner's verdict. */
  _scanCacheKey(fileBuffer) {
    const digest = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    return `scan:${config.virusScannerBackend || 'log'}:${digest}`;
  }

  async _readScanCache(key) {
    try {
      return await cache.get(key);
    } catch (err) {
      // A cache outage must not block uploads: scan normally instead.
      logger.warn('Virus scan cache read failed, scanning instead', { error: err.message });
      return null;
    }
  }

  async _writeScanCache(key, result) {
    try {
      await cache.set(key, result, SCAN_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn('Virus scan cache write failed', { error: err.message });
    }
  }

  async scan(fileBuffer, filename = 'upload') {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer must be a Buffer');
    }

    const cacheKey = this._scanCacheKey(fileBuffer);
    const cached = await this._readScanCache(cacheKey);
    if (cached && typeof cached.infected === 'boolean') {
      logger.info('Virus scan result served from cache', { filename, infected: cached.infected });
      return { infected: cached.infected, threats: cached.threats || [] };
    }

    try {
      const result = await this.backend.scan(fileBuffer, filename);
      logger.info('Virus scan completed', {
        filename,
        infected: result.infected,
        threatCount: (result.threats || []).length,
      });

      const normalized = {
        infected: result.infected,
        threats: result.threats || [],
      };
      await this._writeScanCache(cacheKey, normalized);
      return normalized;
    } catch (err) {
      logger.error('Virus scan error', { error: err.message, filename });
      throw err;
    }
  }
}

const defaultScanner = new VirusScanner();

module.exports = {
  VirusScanner,
  defaultScanner,
  scan: (fileBuffer, filename) => defaultScanner.scan(fileBuffer, filename),
};
