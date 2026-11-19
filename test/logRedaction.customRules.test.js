'use strict';

const {
  redactInfo,
  setCustomRedactionRules,
  getCustomRedactionRules,
} = require('../src/services/logRedaction');

afterEach(() => {
  setCustomRedactionRules([]);
});

describe('custom log redaction rules (#698)', () => {
  test('applies a custom rule to string values', () => {
    setCustomRedactionRules([
      { name: 'account', pattern: /ACC-\d{6}/, replacement: '[ACCOUNT]' },
    ]);
    const out = redactInfo({ message: 'account ACC-123456 closed' });
    expect(out.message).toBe('account [ACCOUNT] closed');
  });

  test('replaces every match, even when the pattern has no g flag', () => {
    setCustomRedactionRules([{ name: 'code', pattern: /X\d/, replacement: '[CODE]' }]);
    const out = redactInfo({ message: 'X1 and X2' });
    expect(out.message).toBe('[CODE] and [CODE]');
  });

  test('uses [REDACTED] when no replacement is given', () => {
    setCustomRedactionRules([{ name: 'token-ish', pattern: /tok_\w+/ }]);
    const out = redactInfo({ message: 'got tok_abc' });
    expect(out.message).toBe('got [REDACTED]');
  });

  test('clearing the rules restores the default output', () => {
    setCustomRedactionRules([{ name: 'code', pattern: /X\d/, replacement: '[CODE]' }]);
    setCustomRedactionRules([]);
    expect(getCustomRedactionRules()).toEqual([]);
    expect(redactInfo({ message: 'X1' }).message).toBe('X1');
  });

  test('rejects a pattern that is not a RegExp', () => {
    expect(() => setCustomRedactionRules([{ name: 'bad', pattern: 'x' }])).toThrow(
      /pattern must be a RegExp/
    );
  });

  test('rejects a rule without a name', () => {
    expect(() => setCustomRedactionRules([{ pattern: /x/ }])).toThrow(/needs a non-empty name/);
  });
});
