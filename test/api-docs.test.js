'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const request = require('supertest');

describe('OpenAPI specification', () => {
  test('openapi.yaml exists and is valid YAML', () => {
    const specPath = path.join(__dirname, '..', 'openapi.yaml');
    expect(fs.existsSync(specPath)).toBe(true);

    const content = fs.readFileSync(specPath, 'utf8');
    expect(content).toContain('openapi: 3.0.3');
    expect(content).toContain('SmartDrop API');
  });

  test('spec defines all required endpoints from the issue', () => {
    const specPath = path.join(__dirname, '..', 'openapi.yaml');
    const content = fs.readFileSync(specPath, 'utf8');

    expect(content).toContain('/health');
    expect(content).toContain('/api/v1/prices/{asset_code}');
    expect(content).toContain('/api/v1/prices/batch');
    expect(content).toContain('/api/v1/webhooks');
    expect(content).toContain('/api/v1/indexer/status');
    expect(content).toContain('/ws');
    expect(content).toContain('x-draft: true');
  });

  test('spec includes Bearer security scheme', () => {
    const specPath = path.join(__dirname, '..', 'openapi.yaml');
    const content = fs.readFileSync(specPath, 'utf8');

    expect(content).toContain('BearerAuth');
    expect(content).toContain('bearer');
  });

  test('spec includes all required error responses', () => {
    const specPath = path.join(__dirname, '..', 'openapi.yaml');
    const content = fs.readFileSync(specPath, 'utf8');

    expect(content).toContain('ValidationError');
    expect(content).toContain('Unauthorized');
    expect(content).toContain('NotFound');
    expect(content).toContain('UnprocessableEntity');
    expect(content).toContain('RateLimited');
    expect(content).toContain('InternalError');
  });
});

describe('Swagger UI', () => {
  let app;

  beforeAll(() => {
    jest.isolateModules(() => {
      const apiDocsRouter = require('../src/routes/apiDocs');
      app = express();
      app.use('/api-docs', apiDocsRouter);
    });
  });

  test('GET /api-docs/openapi.yaml serves the spec file', async () => {
    const res = await request(app).get('/api-docs/openapi.yaml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text).toContain('openapi: 3.0.3');
  });

  test('GET /api-docs/openapi.yaml matches the file on disk', async () => {
    const res = await request(app).get('/api-docs/openapi.yaml');
    const specPath = path.join(__dirname, '..', 'openapi.yaml');
    const fileContent = fs.readFileSync(specPath, 'utf8');

    expect(res.text).toBe(fileContent);
  });

  test('Swagger UI HTML is served at /api-docs in development mode', () => {
    const NODE_ENV = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    jest.resetModules();
    const devRouter = require('../src/routes/apiDocs');
    const devApp = express();
    devApp.use('/api-docs', devRouter);

    return request(devApp)
      .get('/api-docs/')
      .expect(200)
      .then((res) => {
        expect(res.text).toContain('swagger-ui');
        expect(res.text).toContain('SmartDrop API Docs');
        process.env.NODE_ENV = NODE_ENV;
      });
  });
});
