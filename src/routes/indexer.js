const express = require('express');
const eventStore = require('../indexer/eventStore');
const indexerPoller = require('../indexer/runtime');
const logger = require('../logger');

const router = express.Router();

function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

function isValidAddress(value) {
  return typeof value === 'string' && /^[A-Z0-9]{10,80}$/.test(value);
}

router.get('/airdrops/:id/status', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid airdrop id' });
    }

    const status = await eventStore.getAirdropStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Airdrop not indexed' });
    }

    return res.json(status);
  } catch (err) {
    logger.error('Airdrop status lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/airdrops/:id/recipients', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid airdrop id' });
    }

    const recipients = await eventStore.getAirdropRecipients(req.params.id);
    return res.json({ airdrop_id: req.params.id, recipients });
  } catch (err) {
    logger.error('Airdrop recipients lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/recipients/:address/claims', async (req, res) => {
  try {
    if (!isValidAddress(req.params.address)) {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const claims = await eventStore.getRecipientClaims(req.params.address);
    return res.json({ recipient: req.params.address, claims });
  } catch (err) {
    logger.error('Recipient claims lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/indexer/status', async (_req, res) => {
  try {
    const stats = await eventStore.getStats();
    const poller = indexerPoller.getStatus();
    const hasLatestLedger = poller.latest_ledger !== null && poller.latest_ledger !== undefined;
    const latestLedger = Number(poller.latest_ledger);
    const lastLedger = Number(stats.last_ledger);
    const ledgerLag = hasLatestLedger && Number.isFinite(latestLedger) && Number.isFinite(lastLedger)
      ? Math.max(0, latestLedger - lastLedger)
      : null;

    return res.json({
      ...poller,
      last_ledger: stats.last_ledger,
      events_count: stats.events_count,
      lag: ledgerLag,
      ledger_lag: ledgerLag,
    });
  } catch (err) {
    logger.error('Indexer status lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
