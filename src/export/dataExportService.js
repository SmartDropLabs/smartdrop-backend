'use strict';

const logger = require('../logger');

/**
 * Data export service (#511).
 *
 * Generates a complete data export for a user, supporting GDPR's right to
 * data portability. Collects user profile, airdrops, transactions, and
 * activity logs into a single structured response.
 */

/**
 * Collects all user-related data for export.
 *
 * @param {string} userId - The user's unique identifier
 * @param {Object} stores - Collection of data store repositories
 * @param {Object} stores.userStore - User profile repository
 * @param {Object} [stores.airdropStore] - Airdrop repository
 * @param {Object} [stores.transactionStore] - Transaction repository
 * @param {Object} [stores.activityStore] - Activity log repository
 * @returns {Promise<Object>} Structured export data
 */
async function generateExport(userId, stores) {
  const { userStore, airdropStore, transactionStore, activityStore } = stores;

  const user = await userStore.findByIdentifier?.(userId) ?? await userStore.findById?.(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  // Strip sensitive fields from the export
  const safeUser = {
    id: user.id,
    email: user.email,
    username: user.username,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };

  const exportData = {
    export_metadata: {
      generated_at: new Date().toISOString(),
      format_version: '1.0',
      user_id: userId,
    },
    profile: safeUser,
    airdrops: [],
    transactions: [],
    activity_log: [],
  };

  // Collect airdrops
  if (airdropStore) {
    try {
      const airdrops = await airdropStore.findByUser?.(userId) ?? [];
      exportData.airdrops = airdrops.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        total_amount: a.total_amount,
        created_at: a.created_at,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to export airdrops');
    }
  }

  // Collect transactions
  if (transactionStore) {
    try {
      const transactions = await transactionStore.findByUser?.(userId) ?? [];
      exportData.transactions = transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        asset: t.asset,
        status: t.status,
        created_at: t.created_at,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to export transactions');
    }
  }

  // Collect activity log
  if (activityStore) {
    try {
      const activity = await activityStore.findByUser?.(userId) ?? [];
      exportData.activity_log = activity.map((a) => ({
        action: a.action,
        ip_address: a.ip_address,
        created_at: a.created_at,
      }));
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to export activity log');
    }
  }

  logger.info({ userId, sections: Object.keys(exportData).length }, 'Data export generated');
  return exportData;
}

module.exports = {
  generateExport,
};
