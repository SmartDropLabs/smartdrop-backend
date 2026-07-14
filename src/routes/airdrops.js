const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
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

const router = express.Router();
const upload = multer();
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

function parseRecipients(recipients, next) {
  const result = recipientsSchema.safeParse(recipients);
  if (!result.success) {
    return next(new AppError('VALIDATION_ERROR', 'Validation failed', 400, {
      fields: flattenZodIssues(result.error),
    }));
  }
  return result.data;
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

router.post('/airdrops', validateWithCurrentLedger(airdropCreateBodySchema), async (req, res, next) => {
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

router.post('/airdrops/:id/recipients', validateRouteIdParams, upload.single('file'), validateRecipientBody, async (req, res, next) => {
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
