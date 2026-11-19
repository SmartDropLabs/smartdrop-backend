'use strict';

// #555 — Locale-keyed email template strings.
// Add new locales by extending this map; missing keys fall back to 'en'.

const TEMPLATES = {
  en: {
    airdropConfirmation: {
      subject: 'Your airdrop is confirmed',
      greeting: 'Hello {{name}},',
      body: 'Your airdrop of {{amount}} {{asset}} has been confirmed and will be distributed soon.',
      cta: 'View Airdrop',
      footer: 'You received this because you registered for a SmartDrop airdrop.',
    },
    poolReward: {
      subject: 'Pool reward distributed',
      greeting: 'Hello {{name}},',
      body: 'A reward of {{amount}} {{asset}} has been distributed from pool {{poolId}}.',
      cta: 'View Pool',
      footer: 'You received this because you are a member of this pool.',
    },
    priceAlert: {
      subject: '{{asset}} price alert',
      greeting: 'Hello {{name}},',
      body: '{{asset}} has reached your alert threshold of {{threshold}}. Current price: {{price}}.',
      cta: 'View Prices',
      footer: 'You received this because you set up a price alert.',
    },
    passwordChanged: {
      subject: 'Your password was changed',
      greeting: 'Hello {{name}},',
      body: 'Your account password was changed. If you did not do this, contact support immediately.',
      cta: 'Contact Support',
      footer: 'This is a security notification from SmartDrop.',
    },
  },
  fr: {
    airdropConfirmation: {
      subject: 'Votre airdrop est confirmé',
      greeting: 'Bonjour {{name}},',
      body: 'Votre airdrop de {{amount}} {{asset}} a été confirmé et sera distribué prochainement.',
      cta: 'Voir l\'Airdrop',
      footer: 'Vous avez reçu ceci parce que vous vous êtes inscrit à un airdrop SmartDrop.',
    },
    poolReward: {
      subject: 'Récompense de pool distribuée',
      greeting: 'Bonjour {{name}},',
      body: 'Une récompense de {{amount}} {{asset}} a été distribuée depuis le pool {{poolId}}.',
      cta: 'Voir le Pool',
      footer: 'Vous avez reçu ceci parce que vous êtes membre de ce pool.',
    },
    priceAlert: {
      subject: 'Alerte de prix {{asset}}',
      greeting: 'Bonjour {{name}},',
      body: '{{asset}} a atteint votre seuil d\'alerte de {{threshold}}. Prix actuel : {{price}}.',
      cta: 'Voir les Prix',
      footer: 'Vous avez reçu ceci parce que vous avez configuré une alerte de prix.',
    },
    passwordChanged: {
      subject: 'Votre mot de passe a été modifié',
      greeting: 'Bonjour {{name}},',
      body: 'Le mot de passe de votre compte a été modifié. Si vous n\'êtes pas à l\'origine de cette action, contactez le support immédiatement.',
      cta: 'Contacter le Support',
      footer: 'Il s\'agit d\'une notification de sécurité de SmartDrop.',
    },
  },
  es: {
    airdropConfirmation: {
      subject: 'Tu airdrop está confirmado',
      greeting: 'Hola {{name}},',
      body: 'Tu airdrop de {{amount}} {{asset}} ha sido confirmado y se distribuirá pronto.',
      cta: 'Ver Airdrop',
      footer: 'Recibiste esto porque te registraste para un airdrop de SmartDrop.',
    },
    poolReward: {
      subject: 'Recompensa de pool distribuida',
      greeting: 'Hola {{name}},',
      body: 'Se ha distribuido una recompensa de {{amount}} {{asset}} del pool {{poolId}}.',
      cta: 'Ver Pool',
      footer: 'Recibiste esto porque eres miembro de este pool.',
    },
    priceAlert: {
      subject: 'Alerta de precio {{asset}}',
      greeting: 'Hola {{name}},',
      body: '{{asset}} ha alcanzado tu umbral de alerta de {{threshold}}. Precio actual: {{price}}.',
      cta: 'Ver Precios',
      footer: 'Recibiste esto porque configuraste una alerta de precio.',
    },
    passwordChanged: {
      subject: 'Tu contraseña fue cambiada',
      greeting: 'Hola {{name}},',
      body: 'La contraseña de tu cuenta fue cambiada. Si no fuiste tú, contacta al soporte inmediatamente.',
      cta: 'Contactar Soporte',
      footer: 'Esta es una notificación de seguridad de SmartDrop.',
    },
  },
};

const SUPPORTED_LOCALES = Object.keys(TEMPLATES);
const DEFAULT_LOCALE = 'en';

/**
 * Resolve the best available locale.
 * Accepts BCP 47 tags (e.g. "fr-CA") — tries the full tag first, then the
 * base language ("fr"), then falls back to DEFAULT_LOCALE.
 */
function resolveLocale(locale) {
  if (!locale || typeof locale !== 'string') return DEFAULT_LOCALE;
  const normalized = locale.toLowerCase().replace('_', '-');
  if (TEMPLATES[normalized]) return normalized;
  const base = normalized.split('-')[0];
  if (TEMPLATES[base]) return base;
  return DEFAULT_LOCALE;
}

/**
 * Retrieve a localized email template.
 *
 * @param {string} templateName - Key in the TEMPLATES map (e.g. 'airdropConfirmation')
 * @param {string} [locale] - BCP 47 locale string; falls back to 'en'
 * @returns {object} Template strings for the requested locale
 */
function getTemplate(templateName, locale) {
  const resolved = resolveLocale(locale);
  const localeTemplates = TEMPLATES[resolved] || TEMPLATES[DEFAULT_LOCALE];
  const template = localeTemplates[templateName] || TEMPLATES[DEFAULT_LOCALE][templateName];
  if (!template) {
    throw new Error(`Unknown email template: ${templateName}`);
  }
  return template;
}

/**
 * Interpolate `{{variable}}` placeholders in a template string.
 *
 * @param {string} str - Template string with {{key}} placeholders
 * @param {object} vars - Variable values to substitute
 * @returns {string}
 */
function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : `{{${key}}}`,
  );
}

/**
 * Build a fully interpolated email template.
 *
 * @param {string} templateName
 * @param {object} [vars] - Substitution variables
 * @param {string} [locale]
 * @returns {object} Interpolated template fields
 */
function buildEmail(templateName, vars, locale) {
  const template = getTemplate(templateName, locale);
  if (!vars) return { ...template };
  return Object.fromEntries(
    Object.entries(template).map(([k, v]) => [k, interpolate(v, vars)]),
  );
}

module.exports = {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  getTemplate,
  resolveLocale,
  interpolate,
  buildEmail,
};
