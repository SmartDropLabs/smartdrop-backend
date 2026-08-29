'use strict';

const Sentry = require('@sentry/node');
const config = require('../config');

let initialized = false;

function init() {
  const dsn = config.sentryDsn || process.env.SENTRY_DSN;
  if (dsn) {
    Sentry.init({
      dsn,
      environment: config.nodeEnv || 'development',
      tracesSampleRate: 1.0,
    });
    initialized = true;
  }
  return initialized;
}

function isInitialized() {
  return initialized;
}

function captureException(error, context = {}) {
  if (!error) return null;

  if (initialized) {
    return Sentry.captureException(error, { extra: context });
  }
  return null;
}

function captureMessage(message, level = 'info', context = {}) {
  if (!message) return null;

  if (initialized) {
    return Sentry.captureMessage(message, { level, extra: context });
  }
  return null;
}

// Auto-initialize on import if SENTRY_DSN is present in environment/config
init();

module.exports = {
  init,
  isInitialized,
  captureException,
  captureMessage,
};
