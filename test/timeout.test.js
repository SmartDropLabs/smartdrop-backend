'use strict';

const express = require('express');
const request = require('supertest');
const { routeTimeout } = require('../src/middleware/timeout');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get('/fast', routeTimeout(100), (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/slow', routeTimeout(20), (_req, res, next) => {
    setTimeout(() => {
      if (!res.headersSent) {
        res.json({ ok: true });
      }
    }, 100);
  });

  app.use(errorHandler);
  return app;
}

describe('routeTimeout middleware', () => {
  const app = buildApp();

  test('fast response completes normally', async () => {
    const res = await request(app).get('/fast');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('slow request times out with 504 TIMEOUT', async () => {
    const res = await request(app).get('/slow');

    expect(res.status).toBe(504);
    expect(res.body.error).toMatchObject({
      code: 'TIMEOUT',
      message: 'Route execution timed out',
    });
  });
});
