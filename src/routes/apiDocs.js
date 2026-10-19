const express = require('express');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');
const config = require('../config');

const router = express.Router();

const specPath = path.join(__dirname, '../../openapi.yaml');
const openApiDocument = YAML.load(specPath);

if (!config.apiDocs.enabled) {
  router.use((_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'API documentation is disabled',
      },
    });
  });
} else {
  router.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });

  router.get('/openapi.yaml', (_req, res) => {
    res.type('yaml').sendFile(specPath);
  });

  router.use('/', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    explorer: true,
    customSiteTitle: 'SmartDrop API Docs',
  }));
}

module.exports = router;
