'use strict';

const password = require('./password');
const authService = require('./authService');
const tokenRefresh = require('./tokenRefresh');

module.exports = {
  ...password,
  ...authService,
  ...tokenRefresh,
  tokenRefresh,
};
