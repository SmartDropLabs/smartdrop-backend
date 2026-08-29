const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { name: serviceName, version } = require('../package.json');
const { requestContext } = require('./middleware/requestId');
const { redactFormat } = require('./services/logRedaction');

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

// ==================== FORMAT DECISION ====================
const env = process.env.NODE_ENV || 'development';
const logFormat = process.env.LOG_FORMAT || (env === 'production' ? 'json' : 'pretty');
const useJsonFormat = logFormat === 'json';

// ==================== REQUEST CONTEXT ====================
const requestIdFormat = winston.format((info) => {
  const requestId = requestContext.getStore()?.requestId ?? 'system';
  info.requestId = requestId;
  // snake_case alias so structured log output matches the request_id field
  // name used on delivery records and in API responses (issue #250).
  // `requestId` is kept for existing dashboards and queries.
  if (info.request_id === undefined) info.request_id = requestId;
  return info;
});

const errorTrackerFormat = winston.format((info) => {
  if (info.level === 'error') {
    const errorObj = info.error instanceof Error ? info.error : (info.stack ? info : new Error(info.message || 'Logged Error'));
    const { level, message, timestamp, ...extra } = info;
    require('./services/errorTracker').captureException(errorObj, extra);
  }
  return info;
});

// ==================== BASE FORMATS ====================
const baseFormats = [
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  winston.format.errors({ stack: true }),
  requestIdFormat(),
  redactFormat(),
  errorTrackerFormat(),
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
    // request_id is a snake_case alias of requestId (issue #250); printing
    // both would duplicate the same value in every pretty-formatted line.
    const { service, version: ver, request_id: _requestIdAlias, ...rest } = meta;
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