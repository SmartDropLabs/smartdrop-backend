'use strict';

const { translate, getLocale, translations, DEFAULT_LOCALE, getMissingTranslations } = require('../services/i18n');

// Each test gets a fresh module instance so the in-memory tracker starts empty.
function loadFresh() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../services/i18n');
  });
  return mod;
}

describe('i18n translate', () => {
  it('returns the localized string when the key exists for the locale', () => {
    expect(translate('NOT_FOUND', 'fr')).toBe("La ressource n'existe pas");
    expect(translate('NOT_FOUND', 'es')).toBe('El recurso no existe');
  });

  it('defaults to English when no locale is given', () => {
    expect(translate('NOT_FOUND')).toBe('Resource does not exist');
  });

  it('falls back to English when the locale lacks the key', () => {
    const mod = loadFresh();
    const original = mod.translations.fr.NOT_FOUND;
    delete mod.translations.fr.NOT_FOUND;
    try {
      expect(mod.translate('NOT_FOUND', 'fr')).toBe('Resource does not exist');
    } finally {
      mod.translations.fr.NOT_FOUND = original;
    }
  });

  it('returns the key when no locale and no English entry exist', () => {
    expect(translate('SOME_UNKNOWN_KEY', 'fr')).toBe('SOME_UNKNOWN_KEY');
    expect(translate('SOME_UNKNOWN_KEY')).toBe('SOME_UNKNOWN_KEY');
  });

  it('falls back to English for an unsupported locale', () => {
    expect(translate('UNAUTHORIZED', 'de')).toBe('Missing or invalid API key');
  });

  it('does not treat prototype properties as translations', () => {
    expect(translate('toString', 'en')).toBe('toString');
    expect(translate('constructor', '__proto__')).toBe('constructor');
  });
});

describe('missing translation tracking', () => {
  it('tracks a key missing for the requested locale', () => {
    const mod = loadFresh();
    expect(mod.translate('UNAUTHORIZED', 'de')).toBe('Missing or invalid API key');
    expect(mod.getMissingTranslations()).toEqual([{ locale: 'de', key: 'UNAUTHORIZED' }]);
  });

  it('does not track keys that exist for the requested locale', () => {
    const mod = loadFresh();
    mod.translate('UNAUTHORIZED', 'fr');
    expect(mod.getMissingTranslations()).toEqual([]);
  });

  it('records each (locale, key) pair only once', () => {
    const mod = loadFresh();
    for (let i = 0; i < 5; i++) mod.translate('SOME_KEY', 'de');
    mod.translate('SOME_KEY', 'it');
    expect(mod.getMissingTranslations()).toEqual([
      { locale: 'de', key: 'SOME_KEY' },
      { locale: 'it', key: 'SOME_KEY' },
    ]);
  });

  it('stays bounded and evicts the oldest entries', () => {
    const mod = loadFresh();
    for (let i = 0; i < 600; i++) mod.translate(`KEY_${i}`, 'de');
    const tracked = mod.getMissingTranslations();
    expect(tracked.length).toBeLessThanOrEqual(500);
    expect(tracked[tracked.length - 1].key).toBe('KEY_599');
    expect(tracked.find((t) => t.key === 'KEY_0')).toBeUndefined();
  });

  it('never breaks translate() when tracking throws', () => {
    const mod = loadFresh();
    const spy = jest.spyOn(Map.prototype, 'has').mockImplementation(() => {
      throw new Error('boom');
    });
    const setSpy = jest.spyOn(Set.prototype, 'has').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      expect(() => mod.translate('UNAUTHORIZED', 'de')).not.toThrow();
      expect(mod.translate('UNAUTHORIZED', 'de')).toBe('Missing or invalid API key');
    } finally {
      spy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it('getMissingTranslations returns a copy', () => {
    const mod = loadFresh();
    mod.translate('X_KEY', 'de');
    mod.getMissingTranslations().length = 0;
    expect(mod.getMissingTranslations()).toHaveLength(1);
  });
});

describe('existing exports', () => {
  it('still exposes translate, getLocale, translations and DEFAULT_LOCALE', () => {
    expect(typeof translate).toBe('function');
    expect(typeof getLocale).toBe('function');
    expect(typeof translations).toBe('object');
    expect(DEFAULT_LOCALE).toBe('en');
    expect(typeof getMissingTranslations).toBe('function');
  });

  it('getLocale picks a supported locale from Accept-Language', () => {
    const req = { get: () => 'fr-CA,fr;q=0.9,en;q=0.8' };
    expect(getLocale(req)).toBe('fr');
    expect(getLocale({ get: () => 'de' })).toBe('en');
  });
});
