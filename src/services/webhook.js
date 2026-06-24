const crypto = require('crypto');
const axios = require('axios');
const logger = require('../logger');

async function deliver(webhookUrl, secret, payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');

  try {
    await axios.post(webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-SmartDrop-Signature': `sha256=${sig}`,
      },
      timeout: 5000,
    });
    logger.info('Webhook delivered', { alert_id: payload.alert_id, url: webhookUrl });
  } catch (err) {
    logger.warn('Webhook delivery failed', {
      alert_id: payload.alert_id,
      url: webhookUrl,
      error: err.message,
    });
  }
}

module.exports = { deliver };
