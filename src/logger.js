const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { name: serviceName, version } = require('../package.json');
const { requestContext } = require('./middleware/requestId');

// ==================== LOG LEVEL ====================
const getLogLevel = () => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') return 'info';
  if (env === 'test') return 'warn';
  return 'debug';
};

// ==================== REDACTION ====================
const redactFormat = winston.format((info) => {
  const sensitiveKeys = ['apikey', 'privatekey', 'secret', 'token'];

  const redactValue = (value, key) => {
    if (typeof value !== 'string') return '[REDACTED]';
    if (key.toLowerCase().includes('secret') && value.startsWith('whsec_')) {
      return 'whsec_****';
    }
    return '[REDACTED]';
  };

  const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;

    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveKeys.some(k => lowerKey.includes(k));

      if (isSensitive) {
        obj[key] = redactValue(obj[key], key);
      } else if (typeof obj[key] === 'object') {
        redact(obj[key]);
      }
    }
    return obj;
  };

  return redact(info);
});

// ==================== FORMAT DECISION ====================
const env = process.env.NODE_ENV || 'development';
const logFormat = process.env.LOG_FORMAT || (env === 'production' ? 'json' : 'pretty');
const useJsonFormat = logFormat === 'json';

// ==================== REQUEST CONTEXT ====================
const requestIdFormat = winston.format((info) => {
  info.requestId = requestContext.getStore()?.requestId ?? 'system';
  return info;
});

// ==================== BASE FORMATS ====================
const baseFormats = [
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  winston.format.errors({ stack: true }),
  requestIdFormat(),
  redactFormat(),
];

// ==================== JSON FORMAT ====================
const jsonFormat = winston.format.combine(
  ...baseFormats,
  winston.format.json()
);

// ==================== PRETTY FORMAT ====================
const prettyFormat = winston.format.combine(
  ...baseFormats,
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const { service, version: ver, ...rest } = meta;
    const metaStr = Object.keys(rest).length
      ? ` ${JSON.stringify(rest)}`
      : '';

    return `${timestamp} [${level}] [${service}@${ver}] ${message}${metaStr}${stack ? `\n${stack}` : ''}`;
  })
);

// ==================== TRANSPORTS ====================
const transports = [
  new winston.transports.Console({
    format: useJsonFormat ? jsonFormat : prettyFormat
  })
];

// Optional file logging
if (process.env.LOG_FILE_PATH) {
  transports.push(
    new DailyRotateFile({
      filename: `${process.env.LOG_FILE_PATH}/application-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: jsonFormat
    })
  );
}

// ==================== LOGGER ====================
const logger = winston.createLogger({
  level: getLogLevel(),
  defaultMeta: { service: serviceName, version },
  transports,
  exitOnError: false
});

module.exports = logger;