'use strict';

const request = require('supertest');
const express = require('express');
const {
  checkLiveness,
  checkReadiness,
  checkDatabaseDependency,
  checkRedisDependency,
  withTimeout,
} = require('../src/health/healthCheck');
const healthRouter = require('../src/health');

describe('Health Check Endpoints (#455)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    // Mount health router as in src/index.js
    app.use('/health', healthRouter);
  });

  describe('GET /health/live (Liveness check)', () => {
    test('returns 200 with status ok without touching dependencies', async () => {
      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      // Verify no sensitive data or version details leaked
      expect(res.body.version).toBeUndefined();
      expect(res.body.stack).toBeUndefined();
    });

    test('is unauthenticated and requires no API key or token', async () => {
      const res = await request(app)
        .get('/health/live')
        .set('Authorization', '');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /health/ready (Readiness check)', () => {
    test('healthy: returns 200 when all dependencies are healthy with status and latency', async () => {
      const testApp = express();
      testApp.get('/health/ready', async (req, res) => {
        const result = await checkReadiness({
          dbCheck: async () => ({ status: 'ok', latencyMs: 5 }),
          redisCheck: async () => ({ status: 'ok', latencyMs: 2 }),
        });
        const statusCode = result.status === 'ok' ? 200 : 503;
        res.status(statusCode).json(result);
      });

      const res = await request(testApp).get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies).toEqual({
        database: { status: 'ok', latencyMs: 5 },
        redis: { status: 'ok', latencyMs: 2 },
      });
      // Security: no connection strings, secrets, or internal traces
      expect(JSON.stringify(res.body)).not.toContain('password');
      expect(JSON.stringify(res.body)).not.toContain('postgres://');
      expect(JSON.stringify(res.body)).not.toContain('redis://');
    });

    test('failing dependency: returns 503 when database is down', async () => {
      const testApp = express();
      testApp.get('/health/ready', async (req, res) => {
        const result = await checkReadiness({
          dbCheck: async () => ({ status: 'error', latencyMs: 20 }),
          redisCheck: async () => ({ status: 'ok', latencyMs: 2 }),
        });
        const statusCode = result.status === 'ok' ? 200 : 503;
        res.status(statusCode).json(result);
      });

      const res = await request(testApp).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.database.status).toBe('error');
      expect(res.body.dependencies.redis.status).toBe('ok');
    });

    test('failing dependency: returns 503 when Redis is down', async () => {
      const testApp = express();
      testApp.get('/health/ready', async (req, res) => {
        const result = await checkReadiness({
          dbCheck: async () => ({ status: 'ok', latencyMs: 4 }),
          redisCheck: async () => ({ status: 'error', latencyMs: 0 }),
        });
        const statusCode = result.status === 'ok' ? 200 : 503;
        res.status(statusCode).json(result);
      });

      const res = await request(testApp).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.redis.status).toBe('error');
    });

    test('timeout: returns 503 and reports timeout status when dependency hangs', async () => {
      const testApp = express();
      testApp.get('/health/ready', async (req, res) => {
        const result = await checkReadiness({
          timeoutMs: 50,
          dbCheck: async (timeoutMs) => {
            // Simulate hanging query
            return new Promise((resolve) => {
              setTimeout(() => resolve({ status: 'timeout', latencyMs: timeoutMs }), timeoutMs);
            });
          },
          redisCheck: async () => ({ status: 'ok', latencyMs: 2 }),
        });
        const statusCode = result.status === 'ok' ? 200 : 503;
        res.status(statusCode).json(result);
      });

      const res = await request(testApp).get('/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unhealthy');
      expect(res.body.dependencies.database.status).toBe('timeout');
      expect(res.body.dependencies.database.latencyMs).toBe(50);
    });

    test('withTimeout helper correctly rejects with timeout error', async () => {
      const hangingPromise = new Promise((resolve) => setTimeout(resolve, 5000));
      await expect(withTimeout(hangingPromise, 20)).rejects.toThrow('TIMEOUT');
    });
  });
});
