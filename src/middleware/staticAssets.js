'use strict';

const express = require('express');

function stripTrailingSlashes(value) {
  return (value || '').replace(/\/+$/, '');
}

function createStaticAssetsMiddleware({ directory, cdnBaseUrl, maxAgeSeconds } = {}) {
  const cdnRoot = stripTrailingSlashes(cdnBaseUrl);

  if (cdnRoot) {
    return function cdnAssetRedirect(req, res, next) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();

      let assetPath;
      try {
        assetPath = decodeURIComponent(req.path);
      } catch {
        return next();
      }

      assetPath = stripTrailingSlashes(assetPath).replace(/^\/+/, '');
      if (!assetPath) return next();

      const segments = assetPath.split(/[\\/]+/);
      if (segments.includes('..')) return next();

      const encodedPath = assetPath.split('/').map(encodeURIComponent).join('/');
      const queryIndex = req.originalUrl.indexOf('?');
      const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);

      return res.redirect(302, `${cdnRoot}/${encodedPath}${query}`);
    };
  }

  return express.static(directory, {
    fallthrough: true,
    immutable: true,
    index: false,
    maxAge: Math.max(0, maxAgeSeconds || 0) * 1000,
  });
}

module.exports = { createStaticAssetsMiddleware };
