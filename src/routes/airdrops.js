const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const airdropsService = require('../services/airdrops');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const buildRateLimit = require('../middleware/rateLimit');
const { StrKey } = require('stellar-sdk');

const router = express.Router();
const CSV_PARSE_CHUNK_BYTES = 64 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.airdrops.csvMaxBytes },
});

const createAirdropLimit = buildRateLimit({
  windowSeconds: config.airdrops.rateLimit.windowSeconds,
  max: config.airdrops.rateLimit.max,
  keyPrefix: 'airdrops_create',
});

const addRecipientsLimit = buildRateLimit({
  windowSeconds: config.airdrops.rateLimit.windowSeconds,
  max: config.airdrops.rateLimit.max,
  keyPrefix: 'airdrops_recipients',
});

function uploadRecipientsFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        'PAYLOAD_TOO_LARGE',
        `CSV file cannot exceed ${config.airdrops.csvMaxBytes} bytes`,
        413,
        { max_bytes: config.airdrops.csvMaxBytes }
      ));
    }
    return next(err);
  });
}

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
  if (recipients.length > config.airdrops.maxRecipients) {
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
  const results = [];
  let rowCount = 0;
  const chunks = (function* chunkBuffer() {
    for (let offset = 0; offset < buffer.length; offset += CSV_PARSE_CHUNK_BYTES) {
      yield buffer.subarray(offset, offset + CSV_PARSE_CHUNK_BYTES);
    }
  }());

  await pipeline(Readable.from(chunks), csv(), async (rows) => {
    for await (const data of rows) {
      rowCount += 1;
      if (rowCount > config.airdrops.maxRecipients) {
        throw new AppError('VALIDATION_ERROR', 'recipients cannot exceed 10,000', 400);
      }

      const address = data.address || data.Address || data.ADDRESS;
      const amount = parseFloat(data.amount || data.Amount || data.AMOUNT);
      if (address && !Number.isNaN(amount)) {
        results.push({ address, amount });
      }
    }
  });

  return results;
}

router.post('/airdrops', createAirdropLimit, async (req, res, next) => {
  try {
    const currentLedger = await airdropsService.getCurrentLedger();
    const validationError = validateAirdropCreate(req.body, currentLedger);
    if (validationError) {
      return next(new AppError('VALIDATION_ERROR', validationError, 400));
    }

    const airdrop = await airdropsService.create(req.body);
    return res.status(201).json(airdrop);
  } catch (err) {
    logger.error('Create airdrop error', { error: err.message });
    return next(err);
  }
});

router.get('/airdrops', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await airdropsService.list(page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List airdrops error', { error: err.message });
    return next(err);
  }
});

router.get('/airdrops/:id', async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Get airdrop error', { error: err.message });
    return next(err);
  }
});

router.patch('/airdrops/:id', async (req, res, next) => {
  try {
    const currentLedger = await airdropsService.getCurrentLedger();
    const validationError = validateAirdropUpdate(req.body, currentLedger);
    if (validationError) {
      return next(new AppError('VALIDATION_ERROR', validationError, 400));
    }

    const airdrop = await airdropsService.update(req.params.id, req.body);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Update airdrop error', { error: err.message });
    return next(err);
  }
});

router.delete('/airdrops/:id', async (req, res, next) => {
  try {
    const deleted = await airdropsService.remove(req.params.id);
    if (!deleted) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    logger.error('Delete airdrop error', { error: err.message });
    return next(err);
  }
});

router.post('/airdrops/:id/cancel', async (req, res, next) => {
  try {
    const airdrop = await airdropsService.cancel(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Cancel airdrop error', { error: err.message });
    return next(err);
  }
});

router.post('/airdrops/:id/recipients', addRecipientsLimit, uploadRecipientsFile, async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }

    let recipients = [];
    if (req.file) {
      recipients = await parseCSV(req.file.buffer);
    } else if (req.body.recipients) {
      recipients = Array.isArray(req.body.recipients) ? req.body.recipients : JSON.parse(req.body.recipients);
    } else {
      return next(new AppError('VALIDATION_ERROR', 'recipients or file is required', 400));
    }

    if (recipients.length > config.airdrops.maxRecipients) {
      return next(new AppError('VALIDATION_ERROR', 'recipients cannot exceed 10,000', 400));
    }

    const recipientSet = new Set();
    let sum = 0;
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r.address || !isValidStellarAddress(r.address)) {
        return next(new AppError('VALIDATION_ERROR', `recipient ${i}: invalid Stellar address`, 400));
      }
      if (recipientSet.has(r.address)) {
        return next(new AppError('VALIDATION_ERROR', `recipient ${i}: duplicate address ${r.address}`, 400));
      }
      recipientSet.add(r.address);
      if (typeof r.amount !== 'number' || r.amount <= 0) {
        return next(new AppError('VALIDATION_ERROR', `recipient ${i}: amount must be a positive number`, 400));
      }
      sum += r.amount;
    }

    await airdropsService.addRecipients(req.params.id, recipients);
    return res.status(201).json({ added: recipients.length });
  } catch (err) {
    logger.error('Add recipients error', { error: err.message });
    return next(err);
  }
});

router.get('/airdrops/:id/recipients', async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await airdropsService.listRecipients(req.params.id, page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List recipients error', { error: err.message });
    return next(err);
  }
});

module.exports = router;
