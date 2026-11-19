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
 * When templateVersion is given (#679), it is stored in the job's metadata as
 * `templateVersion` so the version used for a send can be traced and rolled back.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} [options.html] - HTML body
 * @param {string} [options.text] - Plain text body
 * @param {Object} [options.metadata] - Extra metadata for the transport
 * @param {number} [options.templateVersion] - Positive integer version of the template used (#679)
 * @returns {Promise<string>} Job ID
 * @throws {Error} When to/subject are missing or templateVersion is not a positive integer
 */
async function queueEmail(options) {
  const { to, subject, html, text, metadata, templateVersion } = options;
  if (!to || !subject) {
    throw new Error('queueEmail requires to and subject');
  }
  if (templateVersion !== undefined && (!Number.isInteger(templateVersion) || templateVersion < 1)) {
    throw new Error(
      `queueEmail templateVersion must be a positive integer, got ${templateVersion} (subject: "${subject}")`,
    );
  }
  const jobMetadata =
    templateVersion === undefined ? metadata : { ...(metadata || {}), templateVersion };
  return jobQueue.enqueue(EMAIL_JOB_TYPE, { to, subject, html, text, metadata: jobMetadata });
}

/**
 * Emails that failed every retry (#623). They are moved to the job queue's
 * dead-letter list instead of being dropped, so they can be reviewed and
 * re-sent manually.
 *
 * @param {number} [limit=100]
 * @returns {Promise<Array<{job: Object, error: string, failedAt: string}>>}
 */
async function getFailedEmails(limit = 100) {
  return jobQueue.getDeadLetters({ type: EMAIL_JOB_TYPE, limit });
}

module.exports = {
  queueEmail,
  registerEmailHandler,
  getFailedEmails,
  EMAIL_JOB_TYPE,
};
