'use strict';

/**
 * Internationalization (i18n) service for error messages (#571).
 *
 * Supports error message localization based on Accept-Language header.
 * Currently supports: English (en), Spanish (es), French (fr).
 *
 * Missing-translation tracking (#692): when a key has no translation for the
 * requested locale, the (key, locale) pair is recorded once per process in a
 * bounded in-memory tracker. Tracking never throws and never changes the
 * value returned by translate().
 */

const translations = {
  en: {
    UNAUTHORIZED: 'Missing or invalid API key',
    FORBIDDEN: 'Insufficient API key scope',
    NOT_FOUND: 'Resource does not exist',
    VALIDATION_ERROR: 'Request validation failed',
    PAYLOAD_TOO_LARGE: 'Request body is too large',
    RATE_LIMITED: 'Too many requests, please try again later',
    SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
    INTERNAL_ERROR: 'An unexpected error occurred',
    WEBHOOK_LIMIT_EXCEEDED: 'Webhook limit exceeded for this subscriber',
    WEBHOOK_NOT_FOUND: 'Webhook not found',
    AIRDROP_NOT_FOUND: 'Airdrop not found',
  },
  es: {
    UNAUTHORIZED: 'Clave de API faltante o inválida',
    FORBIDDEN: 'Alcance de clave de API insuficiente',
    NOT_FOUND: 'El recurso no existe',
    VALIDATION_ERROR: 'Validación de solicitud fallida',
    PAYLOAD_TOO_LARGE: 'El cuerpo de la solicitud es demasiado grande',
    RATE_LIMITED: 'Demasiadas solicitudes, intente más tarde',
    SERVICE_UNAVAILABLE: 'Servicio temporalmente no disponible',
    INTERNAL_ERROR: 'Ocurrió un error inesperado',
    WEBHOOK_LIMIT_EXCEEDED: 'Límite de webhook excedido para este suscriptor',
    WEBHOOK_NOT_FOUND: 'Webhook no encontrado',
    AIRDROP_NOT_FOUND: 'Airdrop no encontrado',
  },
  fr: {
    UNAUTHORIZED: 'Clé API manquante ou invalide',
    FORBIDDEN: 'Portée de clé API insuffisante',
    NOT_FOUND: 'La ressource n\'existe pas',
    VALIDATION_ERROR: 'Validation de la demande échouée',
    PAYLOAD_TOO_LARGE: 'Le corps de la demande est trop volumineux',
    RATE_LIMITED: 'Trop de demandes, réessayez plus tard',
    SERVICE_UNAVAILABLE: 'Service temporairement indisponible',
    INTERNAL_ERROR: 'Une erreur inattendue s\'est produite',
    WEBHOOK_LIMIT_EXCEEDED: 'Limite de webhook dépassée pour cet abonné',
    WEBHOOK_NOT_FOUND: 'Webhook non trouvé',
    AIRDROP_NOT_FOUND: 'Airdrop non trouvé',
  },
};

const DEFAULT_LOCALE = 'en';

// Maximum number of distinct (locale, key) pairs kept in memory.
const MAX_TRACKED_MISSING = 500;

// Insertion-ordered Set: oldest entry is first, so it can be evicted cheaply.
const missingTranslations = new Set();

function hasOwn(obj, prop) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * Record a (key, locale) pair that had no translation. Each pair is stored
 * once per process; when the tracker is full the oldest pair is evicted.
 * Never throws.
 *
 * @param {string} key
 * @param {string} locale
 */
function trackMissingTranslation(key, locale) {
  try {
    const id = `${String(locale)}\u0000${String(key)}`;
    if (missingTranslations.has(id)) return;
    if (missingTranslations.size >= MAX_TRACKED_MISSING) {
      const oldest = missingTranslations.values().next().value;
      missingTranslations.delete(oldest);
    }
    missingTranslations.add(id);
  } catch (err) {
    // Tracking must never break translation.
  }
}

/**
 * Snapshot of tracked missing translations as { locale, key } objects.
 * Returns a fresh array; mutating it does not affect the tracker.
 *
 * @returns {Array<{locale: string, key: string}>}
 */
function getMissingTranslations() {
  return Array.from(missingTranslations, (id) => {
    const sep = id.indexOf('\u0000');
    return { locale: id.slice(0, sep), key: id.slice(sep + 1) };
  });
}

function parseAcceptLanguage(header) {
  if (!header) return 'en';
  const parts = header.split(',').map((part) => {
    const [lang, q] = part.trim().split(';');
    const quality = q ? parseFloat(q.split('=')[1]) : 1.0;
    return { lang: lang.trim().split('-')[0].toLowerCase(), quality };
  });
  parts.sort((a, b) => b.quality - a.quality);
  return parts.length > 0 ? parts[0].lang : 'en';
}

function getLocale(req) {
  const acceptLanguage = req.get('accept-language');
  const preferred = parseAcceptLanguage(acceptLanguage);
  return hasOwn(translations, preferred) ? preferred : 'en';
}

/**
 * Translate an error message key.
 * Lookup order: requested locale -> English fallback -> the key itself.
 * A missing requested-locale entry is tracked via trackMissingTranslation.
 *
 * @param {string} key
 * @param {string} [locale]
 * @returns {string}
 */
function translate(key, locale = DEFAULT_LOCALE) {
  const localized = hasOwn(translations, locale) && hasOwn(translations[locale], key)
    ? translations[locale][key]
    : undefined;
  if (localized) return localized;

  try {
    trackMissingTranslation(key, locale);
  } catch (err) {
    // Ignore: tracking failures must not affect translation.
  }

  const fallback = hasOwn(translations[DEFAULT_LOCALE], key) ? translations[DEFAULT_LOCALE][key] : undefined;
  return fallback || key;
}

module.exports = {
  translate,
  getLocale,
  translations,
  DEFAULT_LOCALE,
  // Additive (#692): read-only view of tracked missing translations.
  getMissingTranslations,
};
