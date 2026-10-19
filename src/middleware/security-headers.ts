// Issue #482: Missing X-Content-Type-Options header
// Adds security headers to prevent MIME sniffing attacks

import { Request, Response, NextFunction } from 'express';

export interface SecurityHeadersConfig {
  /** Enable X-Content-Type-Options: nosniff */
  contentTypeOptions?: boolean;
  /** Enable X-Frame-Options */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | string;
  /** Enable X-XSS-Protection */
  xssProtection?: boolean;
  /** Enable Strict-Transport-Security (HSTS) */
  hsts?: {
    maxAge: number;
    includeSubDomains?: boolean;
    preload?: boolean;
  };
  /** Enable Content-Security-Policy */
  csp?: string;
  /** Enable Referrer-Policy */
  referrerPolicy?: string;
  /** Enable Permissions-Policy */
  permissionsPolicy?: string;
}

const DEFAULT_CONFIG: SecurityHeadersConfig = {
  contentTypeOptions: true,
  frameOptions: 'DENY',
  xssProtection: true,
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  csp: "default-src 'self'",
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: 'geolocation=(), microphone=(), camera=()',
};

/**
 * Security headers middleware
 * 
 * Adds recommended security headers to all responses to protect against:
 * - MIME sniffing attacks (X-Content-Type-Options)
 * - Clickjacking (X-Frame-Options)
 * - XSS attacks (X-XSS-Protection)
 * - Man-in-the-middle attacks (Strict-Transport-Security)
 * - Content injection (Content-Security-Policy)
 * 
 * Usage:
 * ```
 * app.use(securityHeaders());
 * ```
 */
export function securityHeaders(
  config: SecurityHeadersConfig = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction) => {
    // X-Content-Type-Options: nosniff
    // Prevents browsers from MIME-sniffing the content type
    if (mergedConfig.contentTypeOptions) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // X-Frame-Options
    // Prevents clickjacking by controlling if the page can be embedded in frames
    if (mergedConfig.frameOptions) {
      res.setHeader('X-Frame-Options', mergedConfig.frameOptions);
    }

    // X-XSS-Protection
    // Enables browser's built-in XSS filter
    if (mergedConfig.xssProtection) {
      res.setHeader('X-XSS-Protection', '1; mode=block');
    }

    // Strict-Transport-Security (HSTS)
    // Forces HTTPS connections
    if (mergedConfig.hsts && req.secure) {
      let hstsValue = `max-age=${mergedConfig.hsts.maxAge}`;
      
      if (mergedConfig.hsts.includeSubDomains) {
        hstsValue += '; includeSubDomains';
      }
      
      if (mergedConfig.hsts.preload) {
        hstsValue += '; preload';
      }
      
      res.setHeader('Strict-Transport-Security', hstsValue);
    }

    // Content-Security-Policy
    // Controls resources the browser is allowed to load
    if (mergedConfig.csp) {
      res.setHeader('Content-Security-Policy', mergedConfig.csp);
    }

    // Referrer-Policy
    // Controls how much referrer information is included in requests
    if (mergedConfig.referrerPolicy) {
      res.setHeader('Referrer-Policy', mergedConfig.referrerPolicy);
    }

    // Permissions-Policy (formerly Feature-Policy)
    // Controls which browser features can be used
    if (mergedConfig.permissionsPolicy) {
      res.setHeader('Permissions-Policy', mergedConfig.permissionsPolicy);
    }

    // X-Powered-By
    // Remove this header to avoid disclosing technology stack
    res.removeHeader('X-Powered-By');

    next();
  };
}

/**
 * CORS security headers
 * 
 * Adds CORS headers with security considerations
 */
export function corsSecurityHeaders(options: {
  allowedOrigins: string[];
  allowCredentials?: boolean;
  maxAge?: number;
}): (req: Request, res: Response, next: NextFunction) => void {
  const { allowedOrigins, allowCredentials = false, maxAge = 86400 } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('Origin');

    // Check if origin is allowed
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    // Credentials
    if (allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // Preflight request
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
      res.setHeader('Access-Control-Max-Age', maxAge.toString());
      return res.status(204).end();
    }

    next();
  };
}

/**
 * API-specific security headers
 * Optimized for REST API usage
 */
export function apiSecurityHeaders(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return securityHeaders({
    contentTypeOptions: true,
    frameOptions: 'DENY',
    xssProtection: true,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: false,
    },
    // More permissive CSP for API
    csp: undefined,
    referrerPolicy: 'no-referrer',
    permissionsPolicy: 'geolocation=(), microphone=(), camera=()',
  });
}

/**
 * Security headers audit
 * Returns current security headers configuration
 */
export function auditSecurityHeaders(res: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const securityHeaderNames = [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'X-XSS-Protection',
    'Strict-Transport-Security',
    'Content-Security-Policy',
    'Referrer-Policy',
    'Permissions-Policy',
  ];

  securityHeaderNames.forEach((name) => {
    const value = res.getHeader(name);
    if (value) {
      headers[name] = String(value);
    }
  });

  return headers;
}
