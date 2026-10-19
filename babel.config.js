// Only used by Jest, to transform the handful of ESM-only transitive
// dependencies (@noble/hashes, pulled in by @stellar/stellar-sdk) that Jest's
// default node_modules-ignoring transform can't load. The app itself runs
// on plain Node, which resolves these packages natively — see
// jest.config.js's transformIgnorePatterns comment for details.
module.exports = {
  presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
