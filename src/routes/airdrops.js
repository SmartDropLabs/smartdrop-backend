const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const airdropsService = require('../services/airdrops');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const { flattenZodIssues, validate } = require('../middleware/validate');
const {
  airdropCreateBodySchema,
  airdropRecipientsBodySchema,
  airdropUpdateBodySchema,
  paginationQuerySchema,
  recipientsSchema,
  routeIdParamsSchema,
} = require('../validation/schemas');
const buildRateLimit = require('../middleware/rateLimit');
const { StrKey } = require('stellar-sdk');

const router = express.Router();
const CSV_PARSE_CHUNK_BYTES = 64 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.airdrops.csvMaxBytes },
});
const validateRouteIdParams = validate(routeIdParamsSchema, 'params');
const validatePaginationQuery = validate(paginationQuerySchema, 'query');
const validateRecipientBody = validate(airdropRecipientsBodySchema);

function validateWithCurrentLedger(schemaFactory) {
  return async (req, res, next) => {
    try {
      const currentLedger = await airdropsService.getCurrentLedger();
      return validate(schemaFactory(currentLedger))(req, res, next);
    } catch (err) {
      logger.error('Airdrop validation error', { error: err.message });
      return next(err);
    }
  };
}

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

function parseRecipients(recipients, next) {
  const result = recipientsSchema.safeParse(recipients);
  if (!result.success) {
    return next(new AppError('VALIDATION_ERROR', 'Validation failed', 400, {
      fields: flattenZodIssues(result.error),
    }));
  }
  return result.data;
}

/**
 * Strictly parses a numeric amount string.
 * Accepts only strings matching an optional sign, digits, and an optional decimal part.
 * Rejects empty strings, comma-formatted numbers ("1,000"), and strings with trailing
 * non-numeric content ("100USD", "50 units") — all of which parseFloat would silently
 * truncate or misparse.
 *
 * @param {string} raw - The raw string value from the CSV cell.
 * @returns {number|null} The parsed number, or null if the string is invalid.
 */
function strictParseAmount(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const trimmed = raw.trim();
  // Only allow an optional sign followed by digits with an optional decimal part — nothing else.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
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
      const rawAmount = data.amount || data.Amount || data.AMOUNT;
      const amount = strictParseAmount(rawAmount);

      if (amount === null) {
        throw new AppError(
          'VALIDATION_ERROR',
          `recipient ${rowCount}: amount is missing or invalid — got ${JSON.stringify(rawAmount ?? '')}; ` +
            'value must be a plain number (e.g. "100" or "1.5") with no commas or extra characters',
          400
        );
      }

      results.push({ address, amount });
    }
  });

  return results;
}

router.post('/airdrops', createAirdropLimit, validateWithCurrentLedger(airdropCreateBodySchema), async (req, res, next) => {
  try {
    const airdrop = await airdropsService.create(req.validated.body);
    return res.status(201).json(airdrop);
  } catch (err) {
    logger.error('Create airdrop error', { error: err.message });
    return next(err);
  }
});

router.get('/airdrops', validatePaginationQuery, async (req, res, next) => {
  try {
    const { page, limit } = req.validated.query;
    const result = await airdropsService.list(page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List airdrops error', { error: err.message });
    return next(err);
  }
});

router.get('/airdrops/:id', validateRouteIdParams, async (req, res, next) => {
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

router.patch('/airdrops/:id', validateRouteIdParams, validateWithCurrentLedger(airdropUpdateBodySchema), async (req, res, next) => {
  try {
    const airdrop = await airdropsService.update(req.params.id, req.validated.body);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error('Update airdrop error', { error: err.message });
    return next(err);
  }
});

router.delete('/airdrops/:id', validateRouteIdParams, async (req, res, next) => {
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

router.post('/airdrops/:id/cancel', validateRouteIdParams, async (req, res, next) => {
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

router.post('/airdrops/:id/recipients', validateRouteIdParams, addRecipientsLimit, uploadRecipientsFile, validateRecipientBody, async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }

    let recipients = [];
    if (req.file) {
      recipients = await parseCSV(req.file.buffer);
      recipients = parseRecipients(recipients, next);
      if (!recipients) return undefined;
    } else if (req.validated.body.recipients) {
      recipients = req.validated.body.recipients;
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

router.get('/airdrops/:id/recipients', validateRouteIdParams, validatePaginationQuery, async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError('NOT_FOUND', 'Airdrop not found', 404));
    }

    const { page, limit } = req.validated.query;
    const result = await airdropsService.listRecipients(req.params.id, page, limit);
    return res.json(result);
  } catch (err) {
    logger.error('List recipients error', { error: err.message });
    return next(err);
  }
});

module.exports = router;
