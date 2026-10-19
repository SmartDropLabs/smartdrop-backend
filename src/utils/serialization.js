'use strict';

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serialize(value) {
  return JSON.stringify(value, jsonReplacer);
}

module.exports = { jsonReplacer, serialize };
