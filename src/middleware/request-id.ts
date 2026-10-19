// Issue #481: Add request ID tracking
// Implements request ID middleware for tracing requests across services

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createNamespace, getNamespace, Namespace } from 'cls-hooked';

const REQUEST_ID_HEADER = 'X-Request-ID';
const REQUEST_ID_NAMESPACE = 'smartdrop-request-context';

// Valid request ID pattern: alphanumeric, hyphens, underscores
const VALID_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Request ID context namespace
 */
let requestContext: Namespace;

/**
 * Initialize request context namespace
 */
export function initRequestContext(): void {
  if (!requestContext) {
    requestContext = createNamespace(REQUEST_ID_NAMESPACE);
  }
}

/**
 * Get the current request ID from context
 */
export function getRequestId(): string | undefined {
  const ns = getNamespace(REQUEST_ID_NAMESPACE);
  return ns?.get('requestId');
}

/**
 * Set request ID in context
 */
export function setRequestId(requestId: string): void {
  const ns = getNamespace(REQUEST_ID_NAMESPACE);
  ns?.set('requestId', requestId);
}

/**
 * Generate a new request ID
 */
export function generateRequestId(): string {
  return uuidv4();
}

/**
 * Validate request ID format
 */
export function isValidRequestId(requestId: string): boolean {
  return (
    typeof requestId === 'string' &&
    VALID_REQUEST_ID_PATTERN.test(requestId) &&
    requestId.length <= 128
  );
}

/**
 * Request ID middleware
 * 
 * Adds request ID tracking to all requests for distributed tracing.
 * 
 * Behavior:
 * - Accepts client-provided X-Request-ID header if valid
 * - Generates new ID if header is missing or invalid
 * - Stores ID in continuation-local-storage for async access
 * - Adds X-Request-ID to response headers
 * - Logs request ID with each request
 * 
 * Usage:
 * ```
 * import { requestIdMiddleware, initRequestContext } from './middleware/request-id';
 * 
 * initRequestContext();
 * app.use(requestIdMiddleware());
 * ```
 */
export function requestIdMiddleware(options: {
  header?: string;
  generator?: () => string;
  logger?: (requestId: string, req: Request) => void;
} = {}): (req: Request, res: Response, next: NextFunction) => void {
  const {
    header = REQUEST_ID_HEADER,
    generator = generateRequestId,
    logger,
  } = options;

  // Initialize context if not already done
  if (!requestContext) {
    initRequestContext();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    requestContext.run(() => {
      // Try to get request ID from header
      let requestId = req.header(header);

      // Validate and sanitize request ID
      if (requestId && !isValidRequestId(requestId)) {
        // Invalid format, generate new one
        requestId = generator();
      } else if (!requestId) {
        // No request ID provided, generate new one
        requestId = generator();
      }

      // Store in request object
      req.requestId = requestId;

      // Store in continuation-local-storage
      setRequestId(requestId);

      // Add to response header
      res.setHeader(header, requestId);

      // Log request with ID
      if (logger) {
        logger(requestId, req);
      }

      next();
    });
  };
}

/**
 * Enhanced logger that includes request ID
 */
export function createRequestLogger(baseLogger: any) {
  return {
    info: (message: string, meta?: any) => {
      const requestId = getRequestId();
      baseLogger.info(message, { ...meta, requestId });
    },
    error: (message: string, meta?: any) => {
      const requestId = getRequestId();
      baseLogger.error(message, { ...meta, requestId });
    },
    warn: (message: string, meta?: any) => {
      const requestId = getRequestId();
      baseLogger.warn(message, { ...meta, requestId });
    },
    debug: (message: string, meta?: any) => {
      const requestId = getRequestId();
      baseLogger.debug(message, { ...meta, requestId });
    },
  };
}

/**
 * HTTP client wrapper that propagates request ID
 */
export function createHttpClientWithRequestId(httpClient: any) {
  return {
    async get(url: string, options: any = {}) {
      const requestId = getRequestId();
      const headers = {
        ...options.headers,
        ...(requestId && { [REQUEST_ID_HEADER]: requestId }),
      };

      return httpClient.get(url, { ...options, headers });
    },

    async post(url: string, data: any, options: any = {}) {
      const requestId = getRequestId();
      const headers = {
        ...options.headers,
        ...(requestId && { [REQUEST_ID_HEADER]: requestId }),
      };

      return httpClient.post(url, data, { ...options, headers });
    },

    async put(url: string, data: any, options: any = {}) {
      const requestId = getRequestId();
      const headers = {
        ...options.headers,
        ...(requestId && { [REQUEST_ID_HEADER]: requestId }),
      };

      return httpClient.put(url, data, { ...options, headers });
    },

    async delete(url: string, options: any = {}) {
      const requestId = getRequestId();
      const headers = {
        ...options.headers,
        ...(requestId && { [REQUEST_ID_HEADER]: requestId }),
      };

      return httpClient.delete(url, { ...options, headers });
    },
  };
}

/**
 * Database query wrapper that logs with request ID
 */
export function createDbClientWithRequestId(dbClient: any, logger: any) {
  return {
    async query(sql: string, params?: any[]) {
      const requestId = getRequestId();
      const startTime = Date.now();

      try {
        const result = await dbClient.query(sql, params);
        const duration = Date.now() - startTime;

        logger.debug('Database query executed', {
          requestId,
          duration,
          rowCount: result.rowCount,
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        logger.error('Database query failed', {
          requestId,
          duration,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        throw error;
      }
    },

    async transaction(callback: (client: any) => Promise<any>) {
      const requestId = getRequestId();
      logger.debug('Starting database transaction', { requestId });

      const startTime = Date.now();

      try {
        const result = await dbClient.transaction(callback);
        const duration = Date.now() - startTime;

        logger.debug('Database transaction completed', { requestId, duration });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        logger.error('Database transaction failed', {
          requestId,
          duration,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        throw error;
      }
    },
  };
}

/**
 * Request ID error handler
 * Includes request ID in error responses
 */
export function requestIdErrorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const requestId = req.requestId || getRequestId();

  // Add request ID to error response
  if (!res.headersSent) {
    const statusCode = (err as any).statusCode || 500;

    res.status(statusCode).json({
      error: err.name || 'Internal Server Error',
      message: err.message,
      requestId,
      timestamp: new Date().toISOString(),
    });
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}
