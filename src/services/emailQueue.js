'use strict';

/**
 * Email queue service (#515).
 *
 * Queues email sending through the job queue to prevent request blocking.
 * Emails are sent asynchronously in the background with retry on failure.
 */

const jobQueue = require('./jobQueue');
const logger = require('../logger');

const EMAIL_JOB_TYPE = 'email-send';

/**
 * Register the email-send handler with the job queue.
 * Replace the placeholder transport with your actual email provider (Resend, SES, etc.).
 */
function registerEmailHandler(transport) {
  jobQueue.register(EMAIL_JOB_TYPE, async (job) => {
    const { to, subject, html, text, metadata } = job.data;
    logger.info('Sending email', { to: to?.substring(0, 3) + '***', subject });
    await transport.send({ to, subject, html, text, ...(metadata && { metadata }) });
    logger.info('Email sent', { to: to?.substring(0, 3) + '***', subject });
  });
}

/**
 * Queue an email for async delivery (#515).
 * Returns immediately — the email is sent in the background.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} [options.html] - HTML body
 * @param {string} [options.text] - Plain text body
 * @param {Object} [options.metadata] - Extra metadata for the transport
 * @returns {Promise<string>} Job ID
 */
async function queueEmail(options) {
  const { to, subject, html, text, metadata } = options;
  if (!to || !subject) {
    throw new Error('queueEmail requires to and subject');
  }
  return jobQueue.enqueue(EMAIL_JOB_TYPE, { to, subject, html, text, metadata });
}

module.exports = {
  queueEmail,
  registerEmailHandler,
  EMAIL_JOB_TYPE,
};
