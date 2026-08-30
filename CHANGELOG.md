# Changelog

All notable changes to this project should be documented in this file.

This project intends to follow [Conventional Commits](https://www.conventionalcommits.org/)
so future releases can have their notes generated automatically from commit
history (e.g. via `conventional-changelog` or `changesets`). Until that
tooling is wired up, entries below are added manually per release.

## Unreleased

- **BREAKING** — `fix(webhooks)`: unified the webhook signing scheme and bound
  signatures to a timestamp (#97). Deliveries now sign
  `` `${timestamp}.${rawBody}` `` instead of the raw body alone and carry two
  new headers, `X-SmartDrop-Timestamp` and `X-SmartDrop-Signature-Version: 2`.
  Signatures are accepted only while `|now - timestamp|` is within
  `WEBHOOK_SIGNATURE_MAX_AGE_SECONDS` (new, default 300), checked
  symmetrically so future-dated timestamps are rejected too; previously a
  captured payload stayed replayable indefinitely.

  This is a breaking change to a published contract rather than to an HTTP
  route, so it does not ship under a new `/api/v2` path. **v1 signatures are no
  longer emitted**, and any subscriber verifying an HMAC of the raw body alone
  will begin rejecting deliveries. Migration guidance and a working v2
  verification snippet are in the [webhook signing section of the
  README](README.md#verifying-the-signature-nodejs).
- Added this changelog (#216).
