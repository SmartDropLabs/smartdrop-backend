'use strict';

// Minimal ESLint flat config (Issue #231) — a starting point for consistent
// code style, not a full ruleset. Run with: npx eslint .
module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
    },
    rules: {
      'no-unused-vars': 'warn',
    },
  },
];
