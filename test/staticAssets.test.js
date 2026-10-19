'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { createStaticAssetsMiddleware } = require('../src/middleware/staticAssets');

let directory;

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdrop-static-'));
  fs.writeFileSync(path.join(directory, 'app.js'), 'console.log("app");');
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function buildApp(options) {
  const app = express();
  app.use('/static', createStaticAssetsMiddleware(options));
  app.use((_req, res) => res.status(404).end());
  return app;
}

describe('static assets', () => {
  test('serves local assets with immutable caching when no CDN is configured', async () => {
    const res = await request(buildApp({
      directory,
      cdnBaseUrl: '',
      maxAgeSeconds: 3600,
    })).get('/static/app.js');

    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log("app");');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('max-age=3600');
  });

  test('redirects asset requests to the configured CDN', async () => {
    const res = await request(buildApp({
      directory,
      cdnBaseUrl: 'https://cdn.example.com/assets/',
      maxAgeSeconds: 3600,
    })).get('/static/app.js?v=1');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://cdn.example.com/assets/app.js?v=1');
  });

  test('does not redirect paths that escape the asset root', async () => {
    const res = await request(buildApp({
      directory,
      cdnBaseUrl: 'https://cdn.example.com/assets',
      maxAgeSeconds: 3600,
    })).get('/static/..%2fsecret');

    expect(res.status).toBe(404);
  });
});
