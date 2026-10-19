"use strict";

const AppError = require("../errors/AppError");

function flattenZodIssues(error) {
  return error.issues.reduce((fields, issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_root";
    fields[path] = fields[path] || [];
    fields[path].push(issue.message);
    return fields;
  }, {});
}

function enforceStrictSchema(schema) {
  if (schema && typeof schema.strict === "function") {
    try {
      return schema.strict();
    } catch {
      return schema;
    }
  }
  return schema;
}

function validate(schema, source = "body", options = { strict: true }) {
  const effectiveSchema = options.strict !== false ? enforceStrictSchema(schema) : schema;

  return (req, _res, next) => {
    const rawInput = req[source] ?? {};
    const result = effectiveSchema.safeParse(rawInput);
    if (!result.success) {
      return next(
        new AppError("VALIDATION_ERROR", "Validation failed", 400, {
          fields: flattenZodIssues(result.error),
        }),
      );
    }

    req.validated = {
      ...(req.validated || {}),
      [source]: result.data,
    };
    return next();
  };
}

module.exports = {
  flattenZodIssues,
  validate,
  enforceStrictSchema,
};
