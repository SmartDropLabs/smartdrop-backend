'use strict';

const logger = require('../logger');
const config = require('../config');

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

  async scan(fileBuffer, filename = 'upload') {
    if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
      throw new Error('fileBuffer must be a Buffer');
    }

    try {
      const result = await this.backend.scan(fileBuffer, filename);
      logger.info('Virus scan completed', {
        filename,
        infected: result.infected,
        threatCount: (result.threats || []).length,
      });

      return {
        infected: result.infected,
        threats: result.threats || [],
      };
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
