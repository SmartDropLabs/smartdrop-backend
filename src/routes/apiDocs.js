const express = require('express');
const path = require('path');
const YAML = require('yamljs');
const swaggerUi = require('swagger-ui-express');
const config = require('../config');

const router = express.Router();

const specPath = path.join(__dirname, '../../openapi.yaml');
const openApiDocument = YAML.load(specPath);

// Surface the API version in the docs. API_VERSION overrides the version
// declared in openapi.yaml so deployments can be tracked without editing the spec.
const apiVersion = process.env.API_VERSION || openApiDocument.info.version;
openApiDocument.info.version = apiVersion;
openApiDocument.version = apiVersion;

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
    res.type('yaml').send(YAML.stringify(openApiDocument, 10, 2));
  });

  router.use('/', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
    explorer: true,
    customSiteTitle: 'SmartDrop API Docs',
  }));
}

module.exports = router;
