'use strict';

const express = require('express');
const request = require('supertest');
const {
  signJwt,
  createTokenPair,
  refreshTokens,
  revokeRefreshToken,
  createRefreshHandler,
  createRevokeHandler,
} = require('../src/auth/tokenRefresh');
const { verifyJwt } = require('../src/middleware/jwtAuth');
const { errorHandler } = require('../src/middleware/errorHandler');
jest.mock('../src/services/cache', () => ({
  isConnected: jest.fn(() => false),
  getClient: jest.fn(() => null),
}));

jest.mock('../src/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const TEST_SECRET = 'super-secret-jwt-signing-key-for-test-12345';

describe('Token Refresh Mechanism (#521)', () => {
  const testUser = {
    id: 'usr_abc123',
    email: 'user@smartdrop.org',
    username: 'smartdrop_user',
    scopes: ['read', 'write'],
  };

  describe('signJwt & verifyJwt Integration', () => {
    test('signed JWT is verified by verifyJwt', () => {
      const token = signJwt(
        { sub: testUser.id, email: testUser.email },
        TEST_SECRET,
        { expiresInSeconds: 60 }
      );

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const verified = verifyJwt(token, TEST_SECRET);
      expect(verified.sub).toBe(testUser.id);
      expect(verified.email).toBe(testUser.email);
      expect(verified.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test('expired JWT fails verification', () => {
      const expiredToken = signJwt(
        { sub: testUser.id },
        TEST_SECRET,
        { expiresInSeconds: -10 }
      );

      expect(() => verifyJwt(expiredToken, TEST_SECRET)).toThrow(/expired/);
    });
  });

  describe('createTokenPair', () => {
    test('creates access and refresh token pair with correct metadata', async () => {
      const pair = await createTokenPair(testUser, {
        jwtSecret: TEST_SECRET,
        accessTokenTtlSeconds: 300,
        refreshTokenTtlSeconds: 3600,
      });

      expect(pair.tokenType).toBe('Bearer');
      expect(pair.expiresIn).toBe(300);
      expect(pair.accessToken).toBeTruthy();
      expect(pair.refreshToken).toMatch(/^[a-f0-9]{64}$/);
      expect(pair.user.id).toBe(testUser.id);

      // Verify access token
      const verified = verifyJwt(pair.accessToken, TEST_SECRET);
      expect(verified.userId).toBe(testUser.id);
      expect(verified.scopes).toEqual(['read', 'write']);
    });
  });

  describe('refreshTokens with Refresh Token Rotation (RTR)', () => {
    test('refreshes token pair and rotates refresh token', async () => {
      const initialPair = await createTokenPair(testUser, { jwtSecret: TEST_SECRET });

      // Refresh with valid refresh token
      const refreshedPair = await refreshTokens(initialPair.refreshToken, {
        jwtSecret: TEST_SECRET,
      });

      expect(refreshedPair.accessToken).toBeTruthy();
      expect(refreshedPair.refreshToken).toBeTruthy();
      expect(refreshedPair.refreshToken).not.toBe(initialPair.refreshToken);
      expect(refreshedPair.user.id).toBe(testUser.id);

      // Verify the new access token
      const verified = verifyJwt(refreshedPair.accessToken, TEST_SECRET);
      expect(verified.userId).toBe(testUser.id);
    });

    test('reuse detection: using an already-used refresh token revokes token family', async () => {
      const initialPair = await createTokenPair(testUser, { jwtSecret: TEST_SECRET });

      // 1st refresh (legitimate)
      const refreshedPair = await refreshTokens(initialPair.refreshToken, {
        jwtSecret: TEST_SECRET,
      });

      // 2nd refresh using the SAME initial refresh token (attacker replay / token theft!)
      await expect(
        refreshTokens(initialPair.refreshToken, { jwtSecret: TEST_SECRET })
      ).rejects.toMatchObject({
        statusCode: 401,
        message: expect.stringContaining('reuse detected'),
      });

      // The newly issued token in the family must ALSO have been revoked due to reuse detection!
      await expect(
        refreshTokens(refreshedPair.refreshToken, { jwtSecret: TEST_SECRET })
      ).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    test('rejects missing or empty refresh token with 401', async () => {
      await expect(refreshTokens(null)).rejects.toMatchObject({
        statusCode: 401,
      });
      await expect(refreshTokens('')).rejects.toMatchObject({
        statusCode: 401,
      });
    });

    test('rejects non-existent refresh token with 401', async () => {
      await expect(refreshTokens('a'.repeat(64))).rejects.toMatchObject({
        statusCode: 401,
        message: expect.stringContaining('Invalid or expired'),
      });
    });
  });

  describe('revokeRefreshToken', () => {
    test('revoked token cannot be used to refresh', async () => {
      const pair = await createTokenPair(testUser, { jwtSecret: TEST_SECRET });

      const revoked = await revokeRefreshToken(pair.refreshToken);
      expect(revoked).toBe(true);

      await expect(refreshTokens(pair.refreshToken)).rejects.toMatchObject({
        statusCode: 401,
      });
    });
  });

  describe('Express Handlers', () => {
    function buildApp() {
      const app = express();
      app.use(express.json());
      app.post('/auth/refresh', createRefreshHandler({ jwtSecret: TEST_SECRET }));
      app.post('/auth/revoke', createRevokeHandler());
      app.use(errorHandler);
      return app;
    }

    test('POST /auth/refresh returns 200 and new tokens on valid refresh_token', async () => {
      const app = buildApp();
      const pair = await createTokenPair(testUser, { jwtSecret: TEST_SECRET });

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: pair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.tokenType).toBe('Bearer');
    });

    test('POST /auth/refresh returns 400 when refresh token is missing', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    test('POST /auth/revoke revokes token and returns 200', async () => {
      const app = buildApp();
      const pair = await createTokenPair(testUser, { jwtSecret: TEST_SECRET });

      const res = await request(app)
        .post('/auth/revoke')
        .send({ refreshToken: pair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
    });
  });
});
