'use strict';

const stampede = require('./stampede');
const cacheService = require('../services/cache');

module.exports = {
  ...stampede,
  cache: cacheService,
};
