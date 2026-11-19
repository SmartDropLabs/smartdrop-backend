'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../src/health/healthCheck', () => {
  const actual = jest.requireActual('../src/health/healthCheck');
  return { ...actual, checkReadiness: jest.fn() };
});

const { checkReadiness } = require('../src/health/healthCheck');
const { registerJob } = require('../src/health/jobMonitor');
const healthRouter = require('../src/health/router');
const { buildSummary, escapeHtml, renderDashboard } = require('../src/health/dashboard');

function buildApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

const healthyReadiness = {
  status: 'ok',
  dependencies: {
    database: { status: 'ok', latencyMs: 3 },
    redis: { status: 'ok', latencyMs: 1 },
  },
};

describe('Health dashboard (#580)', () => {
  beforeEach(() => {
    checkReadiness.mockReset();
  });

  test('renders liveness, dependencies and jobs on one HTML page', async () => {
    checkReadiness.mockResolvedValue(healthyReadiness);
    registerJob('dashboardTestJob', {
      getHealth: () => ({ healthy: true, lastRunAt: '2026-01-01T00:00:00.000Z' }),
    });

    const res = await request(buildApp()).get('/health/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('Overall status: <strong>ok</strong>');
    expect(res.text).toContain('<td>database</td><td>ok</td><td>3</td>');
    expect(res.text).toContain('<td>redis</td><td>ok</td><td>1</td>');
    expect(res.text).toContain('<td>dashboardTestJob</td><td>healthy</td>');
    expect(res.text).not.toMatch(/<script|<style|style=/i);
  });

  test('reports unhealthy when a dependency is down, still as a 200 page', async () => {
    checkReadiness.mockResolvedValue({
      status: 'unhealthy',
      dependencies: {
        database: { status: 'timeout', latencyMs: 2000 },
        redis: { status: 'ok', latencyMs: 1 },
      },
    });

    const res = await request(buildApp()).get('/health/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Overall status: <strong>unhealthy</strong>');
    expect(res.text).toContain('<td>database</td><td>timeout</td>');
  });

  test('returns the same summary as JSON with ?format=json', async () => {
    checkReadiness.mockResolvedValue(healthyReadiness);

    const res = await request(buildApp()).get('/health/dashboard?format=json');

    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/ok|unhealthy/);
    expect(res.body.liveness).toBe('ok');
    expect(res.body.dependencies).toEqual([
      { name: 'database', status: 'ok', latencyMs: 3 },
      { name: 'redis', status: 'ok', latencyMs: 1 },
    ]);
  });

  test('escapes job details so the page cannot be used for injection', () => {
    const summary = buildSummary(healthyReadiness, {
      allHealthy: false,
      jobHealth: { '<b>job</b>': { healthy: false, error: '<script>alert(1)</script>' } },
    });

    const html = renderDashboard(summary, new Date('2026-01-01T00:00:00.000Z'));

    expect(summary.status).toBe('unhealthy');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain(escapeHtml('<script>alert(1)</script>'));
    expect(html).toContain('&lt;b&gt;job&lt;/b&gt;');
  });

  test('shows a placeholder row when no jobs are registered', () => {
    const summary = buildSummary(healthyReadiness, { allHealthy: true, jobHealth: {} });

    expect(renderDashboard(summary)).toContain('No background jobs registered');
  });
});
