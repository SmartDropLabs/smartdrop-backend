// Several of @stellar/stellar-sdk's own dependencies (@noble/hashes,
// uint8array-extras, ...) publish ESM-only ("type": "module"). Node
// resolves these fine natively via package.json `exports`, but Jest's
// default config ignores all of node_modules for transformation, so it
// hits raw `import`/`export` syntax and fails with "Cannot use import
// statement outside a module" / "Unexpected token 'export'". Rather than
// naming each ESM-only package individually (fragile as the SDK's own
// dependencies change), un-ignore its whole private dependency tree so
// babel.config.js can transform whichever ones need it.
module.exports = {
  // @noble/hashes, @noble/ed25519, and uint8array-extras (transitive
  // dependencies of @stellar/stellar-sdk, some hoisted to the top level,
  // some nested under the SDK's own node_modules) are ESM-only. Anchored at
  // ^ deliberately: some of these live two node_modules/ segments deep
  // (node_modules/@stellar/stellar-sdk/node_modules/@noble/...), and an
  // unanchored lookahead gets re-tried starting from the *second*
  // node_modules/ occurrence too, which defeats it. Anchoring makes the
  // lookahead scan the whole path exactly once.
  transformIgnorePatterns: [
    "^(?!.*(@noble|uint8array-extras)).*node_modules.*",
  ],
};
