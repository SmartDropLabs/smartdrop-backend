'use strict';

/**
 * #618 — the CSRF token cookie must carry SameSite=Strict and HttpOnly so a
 * browser never attaches it to a cross-site request.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { csrfTokenHandler, CSRF_COOKIE_NAME } = require('../src/middleware/csrf');

function buildApp() {
  const app = express();
  app.get('/csrf-token', csrfTokenHandler);
  return app;
}

function csrfCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  return cookies.find((c) => c.startsWith(`${CSRF_COOKIE_NAME}=`));
}

describe('CSRF token cookie (#618)', () => {
  it('sets the token cookie with SameSite=Strict and HttpOnly', async () => {
    const res = await request(buildApp()).get('/csrf-token');

    expect(res.status).toBe(200);
    const cookie = csrfCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=${encodeURIComponent(res.body.csrf_token)}`);
  });

  it('marks the cookie Secure when the request came over HTTPS', async () => {
    const res = await request(buildApp()).get('/csrf-token').set('X-Forwarded-Proto', 'https');

    expect(csrfCookie(res)).toMatch(/;\s*Secure/i);
  });
});
