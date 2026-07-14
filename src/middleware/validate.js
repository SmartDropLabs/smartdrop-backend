'use strict';

const AppError = require('../errors/AppError');

function flattenZodIssues(error) {
  return error.issues.reduce((fields, issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_root';
    fields[path] = fields[path] || [];
    fields[path].push(issue.message);
    return fields;
  }, {});
}

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return next(new AppError('VALIDATION_ERROR', 'Validation failed', 400, {
        fields: flattenZodIssues(result.error),
      }));
    }

    req.validated = {
      ...(req.validated || {}),
      [source]: result.data,
    };
    req[source] = result.data;
    return next();
  };
}

module.exports = {
  flattenZodIssues,
  validate,
};
