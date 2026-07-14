const express = require('express');
const { validate } = require('../middleware/validate');
const alertsService = require('../services/alerts');
const logger = require('../logger');
const AppError = require('../errors/AppError');
const { alertCreateBodySchema, paginationQuerySchema, routeIdParamsSchema } = require('../validation/schemas');

const router = express.Router();
const validateRouteIdParams = validate(routeIdParamsSchema, 'params');

const { parsePagination, paginateResponse } = require('../utils/paginate');

router.post('/alerts', validate(alertCreateBodySchema), async (req, res, next) => {
  try {
    const alert = await alertsService.create(req.validated.body);
    return res.status(201).json(alert);
  } catch (err) {
    logger.error('Create alert error', { error: err.message });
    return next(err);
  }
});

router.get('/alerts', validate(paginationQuerySchema, 'query'), async (req, res, next) => {
  try {
    const pagination = parsePagination(req.query);
    const result = await alertsService.listPaginated(pagination);
    return res.json(
      paginateResponse(
        result.alerts,
        result.total,
        pagination
      ));
  } catch (err) {
    logger.error('List alerts error', { error: err.message });
    return next(err);
  }
});

router.delete('/alerts/:id', validateRouteIdParams, async (req, res, next) => {
  try {
    const deleted = await alertsService.remove(req.params.id);
    if (!deleted) {
      return next(new AppError('NOT_FOUND', 'Alert not found', 404));
    }
    return res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    logger.error('Delete alert error', { error: err.message });
    return next(err);
  }
});

module.exports = router;
