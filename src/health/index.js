'use strict';

const router = require('./router');
const healthCheck = require('./healthCheck');

module.exports = router;
Object.assign(module.exports, healthCheck);
