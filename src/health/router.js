'use strict';

const express = require('express');
const { checkLiveness, checkReadiness, checkJobHealth } = require('./healthCheck');
const { getJobs } = require('./jobMonitor');

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

module.exports = router;
