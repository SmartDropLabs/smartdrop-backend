
const express = require('express');
const { validate } = require('../middleware/validate');
const alertsService = require('../services/alerts');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const {
  alertCreateBodySchema,
  paginationQuerySchema,
  routeIdParamsSchema,
} = require('../validation/schemas');

const router = express.Router();
const validateRouteIdParams = validate(routeIdParamsSchema, 'params');

const { parsePagination, paginateResponse } = require('../utils/paginate');

/**
 * POST /alerts
 * Create an alert.
 */
router.post('/alerts', validate(alertCreateBodySchema), async (req, res, next) => {
  try {
    const alert = await alertsService.create(req.validated.body);
    return res.status(201).json(alert);
  } catch (err) {
    logger.error('Create alert error', { error: err.message });
    return next(err);
  }
});

/**
 * GET /alerts
 * List alerts with optional filtering and pagination.
 *
 * Supported query filters:
 * - type
 * - severity
 * - status
 *
 * Example:
 * GET /alerts?type=price&severity=high&status=active&page=1&limit=20
 */
router.get('/alerts', validate(paginationQuerySchema, 'query'), async (req, res, next) => {
  try {
    const query = req.validated.query;
    const pagination = parsePagination(query);

    const filters = {
      ...(query.type && { type: query.type }),
      ...(query.severity && { severity: query.severity }),
      ...(query.status && { status: query.status }),
    };

    const result = await alertsService.listPaginated(pagination, filters);

    return res.json(
      paginateResponse(
        result.alerts,
        result.total,
        pagination,
      ),
    );
  } catch (err) {
    logger.error('List alerts error', {
      error: err.message,
      filters: {
        type: req.query.type,
        severity: req.query.severity,
        status: req.query.status,
      },
    });
    return next(err);
  }
});

/**
 * DELETE /alerts/:id
 * Delete an alert after verifying resource ownership.
 */
router.delete('/alerts/:id', validateRouteIdParams, async (req, res, next) => {
  try {
    const alertId = req.validated?.params?.id || req.params.id;

    // #508 — verify resource ownership before deletion.
    const alert = await alertsService.get(alertId);

    if (!alert) {
      return next(new AppError('ALERT_NOT_FOUND', 'Alert not found', 404));
    }

    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    if (alert.owner_ip && alert.owner_ip !== clientIp) {
      return next(
        new AppError(
          'FORBIDDEN',
          'You do not have permission to delete this alert',
          403,
        ),
      );
    }

    const deleted = await alertsService.remove(alertId);

    if (!deleted) {
      return next(new AppError('ALERT_NOT_FOUND', 'Alert not found', 404));
    }

    return res.json({ deleted: true, id: alertId });
  } catch (err) {
    logger.error('Delete alert error', { error: err.message });
    return next(err);
  }
});

/**
 * POST /alerts/:id/ack
 * Acknowledge an alert after verifying resource ownership.
 */
router.post('/alerts/:id/ack', validateRouteIdParams, async (req, res, next) => {
  try {
    const alertId = req.validated?.params?.id || req.params.id;

    const alert = await alertsService.get(alertId);

    if (!alert) {
      return next(new AppError('ALERT_NOT_FOUND', 'Alert not found', 404));
    }

    // Same ownership rule as DELETE /alerts/:id (#508).
    const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';

    if (alert.owner_ip && alert.owner_ip !== clientIp) {
      return next(
        new AppError(
          'FORBIDDEN',
          'You do not have permission to acknowledge this alert',
          403,
        ),
      );
    }

    const updated = await alertsService.acknowledge(alertId);

    if (!updated) {
      return next(new AppError('ALERT_NOT_FOUND', 'Alert not found', 404));
    }

    return res.json({
      acknowledged: true,
      id: alertId,
      acknowledged_at: updated.acknowledged_at,
    });
  } catch (err) {
    logger.error('Acknowledge alert error', { error: err.message });
    return next(err);
  }
});

module.exports = router;
