const express = require('express');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');
const config = require('../config');

const router = express.Router();

const openApiDocument = YAML.load(path.join(__dirname, '../../openapi.yaml'));

router.get('/openapi.yaml', (_req, res) => {
  res.type('yaml').sendFile(path.join(__dirname, '../../openapi.yaml'));
});

if (config.nodeEnv === 'development') {
  router.use('/', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    explorer: true,
    customSiteTitle: 'SmartDrop API Docs',
  }));
} else {
  router.get('/', (_req, res) => {
    res.redirect('/api-docs/openapi.yaml');
  });
}

module.exports = router;
