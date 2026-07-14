'use strict';

const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const { validate } = require('../src/middleware/validate');
const { errorHandler } = require('../src/middleware/errorHandler');

function buildApp(schema, source = 'body') {
  const app = express();
  app.use(express.json());
  app.post('/validate/:id?', validate(schema, source), (req, res) => {
    res.json({ validated: req.validated[source] });
  });
  app.use(errorHandler);
  return app;
}

describe('validate middleware', () => {
  test('stores parsed body data on req.validated', async () => {
    const app = buildApp(z.object({
      count: z.coerce.number().int().min(1),
    }));

    const res = await request(app).post('/validate').send({ count: '3' });

    expect(res.status).toBe(200);
    expect(res.body.validated).toEqual({ count: 3 });
  });

  test('returns a validation AppError with flattened field details', async () => {
    const app = buildApp(z.object({
      count: z.coerce.number().int().min(1),
    }));

    const res = await request(app).post('/validate').send({ count: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(res.body.error.details.fields.count).toEqual(expect.any(Array));
  });

  test('validates route params before the handler runs', async () => {
    const app = buildApp(z.object({
      id: z.string().regex(/^ok_[a-z]+$/),
    }), 'params');

    const res = await request(app).post('/validate/bad-id').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.id).toEqual(expect.any(Array));
  });
});
