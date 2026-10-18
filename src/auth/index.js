'use strict';

const password = require('./password');
const authService = require('./authService');
const session = require('./session');

module.exports = {
  ...password,
  ...authService,
  ...session,
};
