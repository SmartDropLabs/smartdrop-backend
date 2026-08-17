const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const config = require("../config");
const airdropsService = require("../services/airdrops");
const { idempotencyMiddleware } = require("../services/idempotency");
const logger = require("../logger");
const AppError = require("../errors/AppError");
const { flattenZodIssues, validate } = require("../middleware/validate");
const {
  airdropCreateBodySchema,
  airdropRecipientsBodySchema,
  airdropUpdateBodySchema,
  paginationQuerySchema,
  recipientsSchema,
  routeIdParamsSchema,
} = require("../validation/schemas");
const buildRateLimit = require("../middleware/rateLimit");
const { routeTimeout } = require("../middleware/timeout");
const { StrKey } = require("stellar-sdk");
const { paginateResponse } = require("../utils/paginate");

// Stellar Int64 max in stroops (1 unit = 10_000_000 stroops for XLM/USDC)
const INT64_MAX_STROOPS = 9223372036854775807n;
const STROOPS_PER_UNIT = 10_000_000n;

const router = express.Router();
const CSV_PARSE_CHUNK_BYTES = 64 * 1024;
// Cap on how many bad rows are enumerated back to the uploader — enough to
// fix a broken file, without echoing a 10,000-line error list.
const MAX_REPORTED_INVALID_ROWS = 20;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.airdrops.csvMaxBytes },
});
const validateRouteIdParams = validate(routeIdParamsSchema, "params");
const validatePaginationQuery = validate(paginationQuerySchema, "query");
const validateRecipientBody = validate(airdropRecipientsBodySchema);

function validateWithCurrentLedger(schemaFactory) {
  return async (req, res, next) => {
    try {
      const currentLedger = await airdropsService.getCurrentLedger();
      return validate(schemaFactory(currentLedger))(req, res, next);
    } catch (err) {
      logger.error("Airdrop validation error", { error: err.message });
      return next(err);
    }
  };
}

const createAirdropLimit = buildRateLimit({
  windowSeconds: config.airdrops.rateLimit.windowSeconds,
  max: config.airdrops.rateLimit.max,
  keyPrefix: "airdrops_create",
});

const addRecipientsLimit = buildRateLimit({
  windowSeconds: config.airdrops.rateLimit.windowSeconds,
  max: config.airdrops.rateLimit.max,
  keyPrefix: "airdrops_recipients",
});

function uploadRecipientsFile(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(
        new AppError(
          "PAYLOAD_TOO_LARGE",
          `CSV file cannot exceed ${config.airdrops.csvMaxBytes} bytes`,
          413,
          { max_bytes: config.airdrops.csvMaxBytes },
        ),
      );
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

function toStroops(amount) {
  return BigInt(Math.round(amount * Number(STROOPS_PER_UNIT)));
}

function assertWithinCeiling(stroops, label) {
  if (stroops > INT64_MAX_STROOPS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${label} exceeds Stellar Int64 ceiling`,
      400,
    );
  }
}

function parseRecipients(recipients, next) {
  const result = recipientsSchema.safeParse(recipients);
  if (!result.success) {
    return next(
      new AppError("VALIDATION_ERROR", "Validation failed", 400, {
        fields: flattenZodIssues(result.error),
      }),
    );
  }
  return result.data;
}

function validateUtf8(buffer) {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buffer);
  } catch {
    throw new AppError(
      "CSV_INVALID_ENCODING",
      "CSV file must be valid UTF-8 encoded",
      400,
    );
  }
}

// Accepted spellings for the two required columns. csv-parser hands back
// header names verbatim, so case and surrounding whitespace are normalized
// here rather than enumerating every variant at each lookup.
const ADDRESS_COLUMN = "address";
const AMOUNT_COLUMN = "amount";

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[String(key).trim().toLowerCase()] = value;
  }
  return normalized;
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
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Only allow an optional sign followed by digits with an optional decimal part — nothing else.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Parses recipient CSV, rejecting malformed input instead of skipping it.
 *
 * Rows that failed validation used to be dropped silently, so a file whose
 * columns were misnamed — or whose amounts were all unparseable — returned
 * 200 OK having imported nothing, with no way for the uploader to tell that
 * from a successful import. Structure is now checked up front (issue #254)
 * and bad rows are reported with their line numbers.
 *
 * Parsing stays streaming: rows are consumed from the pipeline as they are
 * produced, and the row cap is enforced during iteration so an oversized
 * file is abandoned partway rather than fully materialized first.
 */
async function parseCSV(buffer) {
  validateUtf8(buffer);
  const results = [];
  const invalidRows = [];
  let rowCount = 0;
  let headerChecked = false;

  const chunks = (function* chunkBuffer() {
    for (
      let offset = 0;
      offset < buffer.length;
      offset += CSV_PARSE_CHUNK_BYTES
    ) {
      yield buffer.subarray(offset, offset + CSV_PARSE_CHUNK_BYTES);
    }
  })();

  // Throwing out of the pipeline consumer while the source still has data
  // makes stream/promises reject with an AbortError, discarding the original
  // error — which would surface every rejected CSV as a 500 instead of the
  // intended 400. The AppError is stashed here and rethrown once the
  // pipeline has settled, so the reason for stopping survives.
  let abortReason = null;
  const stopWith = (appError) => {
    abortReason = appError;
    return appError;
  };

  try {
    await pipeline(Readable.from(chunks), csv(), async (rows) => {
      for await (const data of rows) {
        const row = normalizeRow(data);

        // Header presence is knowable from the first row; failing here means
        // the rest of the file is not worth parsing at all.
        if (!headerChecked) {
          headerChecked = true;
          const missing = [ADDRESS_COLUMN, AMOUNT_COLUMN].filter(
            (column) => !Object.prototype.hasOwnProperty.call(row, column),
          );
          if (missing.length > 0) {
            throw stopWith(
              new AppError(
                "CSV_MISSING_COLUMNS",
                "CSV is missing required columns",
                400,
                {
                  missing_columns: missing,
                  required_columns: [ADDRESS_COLUMN, AMOUNT_COLUMN],
                  found_columns: Object.keys(row),
                },
              ),
            );
          }
        }

        rowCount += 1;
        if (rowCount > config.airdrops.maxRecipients) {
          throw stopWith(
            new AppError(
              "RECIPIENT_LIMIT_EXCEEDED",
              `CSV cannot exceed ${config.airdrops.maxRecipients} recipients`,
              400,
              { max_recipients: config.airdrops.maxRecipients },
            ),
          );
        }

        const address = row[ADDRESS_COLUMN];
        const rawAmount = row[AMOUNT_COLUMN];
        const amount = strictParseAmount(rawAmount);

        // +1 for the header line, so the number matches what the uploader
        // sees in a text editor.
        const line = rowCount + 1;
        if (!address || String(address).trim() === "") {
          invalidRows.push({ line, reason: "missing address" });
        } else if (amount === null) {
          invalidRows.push({ line, reason: "amount is missing or invalid" });
        } else if (amount <= 0) {
          invalidRows.push({
            line,
            reason: "amount must be greater than zero",
          });
        } else {
          results.push({ address: String(address).trim(), amount });
        }

        // Bail out early rather than accumulating an unbounded error list for
        // a file that is clearly not going to be accepted.
        if (invalidRows.length > MAX_REPORTED_INVALID_ROWS) {
          throw stopWith(
            new AppError(
              "CSV_MALFORMED",
              "CSV contains too many invalid rows",
              400,
              {
                invalid_rows: invalidRows.slice(0, MAX_REPORTED_INVALID_ROWS),
                truncated: true,
              },
            ),
          );
        }
      }
    });
  } catch (err) {
    // An AbortError here is the stream tearing down after our own throw;
    // the real reason was stashed by stopWith. Anything else is a genuine
    // stream or parser failure and propagates unchanged.
    if (abortReason) throw abortReason;
    throw err;
  }

  if (rowCount === 0) {
    throw new AppError("CSV_EMPTY", "CSV contains no data rows", 400);
  }

  if (invalidRows.length > 0) {
    throw new AppError("CSV_MALFORMED", "CSV contains invalid rows", 400, {
      invalid_rows: invalidRows,
      valid_rows: results.length,
      total_rows: rowCount,
    });
  }

  return results;
}

router.post(
  "/airdrops",
  routeTimeout(),
  createAirdropLimit,
  idempotencyMiddleware("airdrop"),
  validateWithCurrentLedger(airdropCreateBodySchema),
  async (req, res, next) => {
    try {
      const airdrop = await airdropsService.create(req.validated.body);
      return res.status(201).json(airdrop);
    } catch (err) {
      logger.error("Create airdrop error", { error: err.message });
      return next(err);
    }
  },
);

router.get("/airdrops", validatePaginationQuery, async (req, res, next) => {
  try {
    const { page, limit } = req.validated.query;
    const result = await airdropsService.list(page, limit);
    return res.json(
      paginateResponse(result.airdrops, result.total, { page, limit }),
    );
  } catch (err) {
    logger.error("List airdrops error", { error: err.message });
    return next(err);
  }
});

router.get("/airdrops/:id", validateRouteIdParams, async (req, res, next) => {
  try {
    const airdrop = await airdropsService.get(req.params.id);
    if (!airdrop) {
      return next(new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404));
    }
    return res.json(airdrop);
  } catch (err) {
    logger.error("Get airdrop error", { error: err.message });
    return next(err);
  }
});

router.patch(
  "/airdrops/:id",
  validateRouteIdParams,
  validateWithCurrentLedger(airdropUpdateBodySchema),
  async (req, res, next) => {
    try {
      const airdrop = await airdropsService.update(
        req.params.id,
        req.validated.body,
      );
      if (!airdrop) {
        return next(
          new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404),
        );
      }
      return res.json(airdrop);
    } catch (err) {
      logger.error("Update airdrop error", { error: err.message });
      return next(err);
    }
  },
);

router.delete(
  "/airdrops/:id",
  validateRouteIdParams,
  async (req, res, next) => {
    try {
      const deleted = await airdropsService.remove(req.params.id);
      if (!deleted) {
        return next(
          new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404),
        );
      }
      return res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      logger.error("Delete airdrop error", { error: err.message });
      return next(err);
    }
  },
);

router.post(
  "/airdrops/:id/cancel",
  validateRouteIdParams,
  async (req, res, next) => {
    try {
      const airdrop = await airdropsService.cancel(req.params.id);
      if (!airdrop) {
        return next(
          new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404),
        );
      }
      return res.json(airdrop);
    } catch (err) {
      logger.error("Cancel airdrop error", { error: err.message });
      return next(err);
    }
  },
);

router.post(
  "/airdrops/:id/recipients",
  routeTimeout(),
  validateRouteIdParams,
  addRecipientsLimit,
  uploadRecipientsFile,
  validateRecipientBody,
  async (req, res, next) => {
    try {
      const airdrop = await airdropsService.get(req.params.id);
      if (!airdrop) {
        return next(
          new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404),
        );
      }

      let recipients = [];
      if (req.file) {
        recipients = await parseCSV(req.file.buffer);
        recipients = parseRecipients(recipients, next);
        if (!recipients) return undefined;
      } else if (req.validated.body.recipients) {
        recipients = req.validated.body.recipients;
      } else {
        return next(
          new AppError(
            "VALIDATION_ERROR",
            "recipients or file is required",
            400,
          ),
        );
      }

      if (recipients.length > config.airdrops.maxRecipients) {
        return next(
          new AppError(
            "VALIDATION_ERROR",
            "recipients cannot exceed 10,000",
            400,
          ),
        );
      }

      const recipientSet = new Set();
      let sum = 0n;
      for (let i = 0; i < recipients.length; i++) {
        const r = recipients[i];
        if (!r.address || !isValidStellarAddress(r.address)) {
          return next(
            new AppError(
              "VALIDATION_ERROR",
              `recipient ${i}: invalid Stellar address`,
              400,
            ),
          );
        }
        if (recipientSet.has(r.address)) {
          return next(
            new AppError(
              "VALIDATION_ERROR",
              `recipient ${i}: duplicate address ${r.address}`,
              400,
            ),
          );
        }
        recipientSet.add(r.address);
        if (
          typeof r.amount !== "number" ||
          r.amount <= 0 ||
          !Number.isFinite(r.amount)
        ) {
          return next(
            new AppError(
              "VALIDATION_ERROR",
              `recipient ${i}: amount must be a positive number`,
              400,
            ),
          );
        }
        const stroops = toStroops(r.amount);
        assertWithinCeiling(stroops, `recipient ${i} amount`);
        sum += stroops;
      }
      assertWithinCeiling(sum, "total recipient amount");

      const duplicates = await airdropsService.addRecipients(
        req.params.id,
        recipients,
      );
      if (duplicates.length > 0) {
        return next(
          new AppError(
            "CONFLICT",
            "One or more recipient addresses are already registered for this airdrop",
            409,
            { duplicate_addresses: duplicates },
          ),
        );
      }
      return res.status(201).json({ added: recipients.length });
    } catch (err) {
      logger.error("Add recipients error", { error: err.message });
      return next(err);
    }
  },
);

router.get(
  "/airdrops/:id/recipients",
  validateRouteIdParams,
  validatePaginationQuery,
  async (req, res, next) => {
    try {
      const airdrop = await airdropsService.get(req.params.id);
      if (!airdrop) {
        return next(
          new AppError("AIRDROP_NOT_FOUND", "Airdrop not found", 404),
        );
      }

      const { page, limit } = req.validated.query;
      const result = await airdropsService.listRecipients(
        req.params.id,
        page,
        limit,
      );
      return res.json(
        paginateResponse(result.recipients, result.total, { page, limit }),
      );
    } catch (err) {
      logger.error("List recipients error", { error: err.message });
      return next(err);
    }
  },
);

module.exports = router;
