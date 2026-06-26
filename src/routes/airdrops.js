const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const airdropsService = require('../services/airdrops');
const logger = require('../logger');
const { StrKey } = require('stellar-sdk');

const router = express.Router();
const upload = multer();

function isValidStellarAddress(address) {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

function validateAirdropCreate(body, currentLedger) {
  const { name, asset, asset_issuer, total_amount, expiry_ledger, recipients = [] } = body;

  if (!name || typeof name !== 'string') {
    return 'name is required and must be a string';
  }
  if (!asset || typeof asset !== 'string' || !/^[A-Z0-9]{1,12}$/i.test(asset)) {
    return 'asset is required and must be 1-12 alphanumeric characters';
  }
  if (!asset_issuer || !isValidStellarAddress(asset_issuer)) {
    return 'asset_issuer is required and must be a valid Stellar address';
  }
  if (typeof total_amount !== 'number' || total_amount <= 0) {
    return 'total_amount is required and must be a positive number';
  }
  if (typeof expiry_ledger !== 'number' || expiry_ledger <= currentLedger) {
    return `expiry_ledger is required and must be greater than current ledger (${currentLedger})`;
  }
  if (recipients.length > 10000) {
    return 'recipients cannot exceed 10,000';
  }

  const recipientSet = new Set();
  let sum = 0;
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    if (!r.address || !isValidStellarAddress(r.address)) {
      return `recipient ${i}: invalid Stellar address`;
    }
    if (recipientSet.has(r.address)) {
      return `recipient ${i}: duplicate address ${r.address}`;
    }
    recipientSet.add(r.address);
    if (typeof r.amount !== 'number' || r.amount <= 0) {
      return `recipient ${i}: amount must be a positive number`;
    }
    sum += r.amount;
  }

  if (recipients.length > 0 && sum !== total_amount) {
    return `sum of recipient amounts (${sum}) must equal total_amount (${total_amount})`;
  }

  return null;
}

function validateAirdropUpdate(body, currentLedger) {
  const { expiry_ledger } = body;
  if (expiry_ledger !== undefined && (typeof expiry_ledger !== 'number' || expiry_ledger <= currentLedger)) {
    return `expiry_ledger must be greater than current ledger (${currentLedger})`;
  }
  return null;
}

async function parseCSV(buffer) {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = Readable.from(buffer);
    stream
      .pipe(csv())
      .on('data', (data) => {
        const address = data.address || data.Address || data.ADDRESS;
        const amount = parseFloat(data.amount || data.Amount || data.AMOUNT);
        if (address && !isNaN(amount)) {
          results.push({ address, amount });
        }
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

router.post('/airdrops', async (req, res) => {
  try {
    const currentLedger = await airdropsService.getCurrentLedger();
    const validationError = validateAirdropCreate(req.body, currentLedger);
    if (validationError) {
      return res.status(400).json({ error: 'Validation error', message: validationError });
    }

    const airdrop = await airdropsService.create(req.body);
    return res.status(201).json(airdrop);
  } catch (err) {
    logger.error('Create airdrop error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/airdrops', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await airdropsService.list(page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List airdrops error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/airdrops/:id', async (req, res) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Get airdrop error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/airdrops/:id', async (req, res) => {
  try {
    const currentLedger = await airdropsService.getCurrentLedger();
    const validationError = validateAirdropUpdate(req.body, currentLedger);
    if (validationError) {
      return res.status(400).json({ error: 'Validation error', message: validationError });
    }

    const airdrop = await airdropsService.update(req.params.id, req.body);
    if (!airdrop) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Update airdrop error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/airdrops/:id', async (req, res) => {
  try {
    const deleted = await airdropsService.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    logger.error('Delete airdrop error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/airdrops/:id/cancel', async (req, res) => {
  try {
    const airdrop = await airdropsService.cancel(req.params.id);
    if (!airdrop) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Cancel airdrop error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/airdrops/:id/recipients', upload.single('file'), async (req, res) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }

    let recipients = [];
    if (req.file) {
      recipients = await parseCSV(req.file.buffer);
    } else if (req.body.recipients) {
      recipients = Array.isArray(req.body.recipients) ? req.body.recipients : JSON.parse(req.body.recipients);
    } else {
      return res.status(400).json({ error: 'Validation error', message: 'recipients or file is required' });
    }

    if (recipients.length > 10000) {
      return res.status(400).json({ error: 'Validation error', message: 'recipients cannot exceed 10,000' });
    }

    const recipientSet = new Set();
    let sum = 0;
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r.address || !isValidStellarAddress(r.address)) {
        return res.status(400).json({ error: 'Validation error', message: `recipient ${i}: invalid Stellar address` });
      }
      if (recipientSet.has(r.address)) {
        return res.status(400).json({ error: 'Validation error', message: `recipient ${i}: duplicate address ${r.address}` });
      }
      recipientSet.add(r.address);
      if (typeof r.amount !== 'number' || r.amount <= 0) {
        return res.status(400).json({ error: 'Validation error', message: `recipient ${i}: amount must be a positive number` });
      }
      sum += r.amount;
    }

    await airdropsService.addRecipients(req.params.id, recipients);
    return res.status(201).json({ added: recipients.length });
  } catch (err) {
    logger.error('Add recipients error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/airdrops/:id/recipients', async (req, res) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return res.status(404).json({ error: 'Airdrop not found' });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await airdropsService.listRecipients(req.params.id, page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List recipients error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
