'use strict';

const express = require('express');
const { checkLiveness, checkReadiness } = require('./healthCheck');

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

module.exports = router;
