'use strict';

/**
 * Internationalization (i18n) service for error messages (#571).
 *
 * Supports error message localization based on Accept-Language header.
 * Currently supports: English (en), Spanish (es), French (fr).
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
  return Object.prototype.hasOwnProperty.call(translations, preferred) ? preferred : 'en';
}

function translate(code, locale = 'en') {
  const localeTranslations = translations[locale] || translations.en;
  return localeTranslations[code] || translations.en[code] || code;
}

module.exports = {
  translate,
  getLocale,
  translations,
};
