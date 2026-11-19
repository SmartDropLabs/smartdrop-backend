'use strict';

const express = require('express');
const { checkLiveness, checkReadiness, checkJobHealth } = require('./healthCheck');
const { getJobs } = require('./jobMonitor');
const { buildSummary, renderDashboard } = require('./dashboard');

const router = express.Router();

// Liveness probe: returns 200 without checking external dependencies
router.get('/live', (req, res) => {
  const result = checkLiveness();
  res.status(200).json(result);
});

router.get('/liveness', (req, res) => {
  const result = checkLiveness();
  res.status(200).json(result);
});

// Readiness probe: checks required dependencies (database, redis) with timeouts
router.get('/ready', async (req, res) => {
  const result = await checkReadiness();
  const statusCode = result.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(result);
});

router.get('/readiness', async (req, res) => {
  const result = await checkReadiness();
  const statusCode = result.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(result);
});

// Background job health: checks status of background jobs
router.get('/jobs', (req, res) => {
  const jobs = getJobs();
  const { jobHealth, allHealthy } = checkJobHealth(jobs);
  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json({ jobs: jobHealth, healthy: allHealthy });
});

// Health dashboard (#580): liveness, readiness and job health on one page.
// `?format=json` returns the same summary as JSON for scripts. Always 200 —
// it is a page for people; probes should keep using /ready and /jobs.
router.get('/dashboard', async (req, res) => {
  const readiness = await checkReadiness();
  const jobs = checkJobHealth(getJobs());
  const summary = buildSummary(readiness, jobs);

  res.set('Cache-Control', 'no-store');
  if (req.query.format === 'json') {
    return res.status(200).json(summary);
  }
  return res.status(200).type('html').send(renderDashboard(summary));
});

module.exports = router;
