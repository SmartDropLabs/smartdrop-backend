const { SorobanRpc } = require('stellar-sdk');
const config = require('../config');
const logger = require('../logger');
const eventStore = require('./eventStore');
const { parseContractEvent } = require('./eventParser');

class EventPoller {
  constructor(options = {}) {
    this.contractId = options.contractId ?? config.indexer.contractId;
    this.pollIntervalMs = options.pollIntervalMs ?? config.indexer.pollIntervalMs;
    this.pollLimit = options.pollLimit ?? config.indexer.pollLimit;
    this.startLedger = options.startLedger ?? config.indexer.startLedger;
    this.enabled = options.enabled ?? config.indexer.enabled;
    this.store = options.store || eventStore;
    this.logger = options.logger || logger;
    this.server = options.server || new SorobanRpc.Server(options.rpcUrl || config.stellar.sorobanRpcUrl);
    this.timer = null;
    this.lastRun = null;
    this.lastError = null;
    this.latestLedger = null;
  }

  isConfigured() {
    return this.enabled && Boolean(this.contractId);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      running: this.timer !== null,
      contract_id: this.contractId || null,
      poll_interval_ms: this.pollIntervalMs,
      poll_limit: this.pollLimit,
      last_run: this.lastRun,
      last_error: this.lastError,
      latest_ledger: this.latestLedger,
    };
  }

  async pollOnce() {
    if (!this.isConfigured()) {
      return { skipped: true, reason: 'SMARTDROP_CONTRACT_ID not configured' };
    }

    const previousLedger = await this.store.getLastLedger(null);
    const startLedger = previousLedger == null
      ? this.startLedger || 0
      : Math.max(Number(previousLedger) + 1, this.startLedger || 0);

    const response = await this.server.getEvents({
      startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [this.contractId],
        },
      ],
      limit: this.pollLimit,
    });

    const parsedEvents = (response.events || [])
      .map(parseContractEvent)
      .filter(Boolean);

    for (const event of parsedEvents) {
      await this.store.saveEvent(event);
    }

    const latestIndexedLedger = Math.max(
      response.latestLedger || previousLedger,
      ...parsedEvents.map((event) => event.ledger)
    );
    await this.store.setLastLedger(latestIndexedLedger);

    this.latestLedger = response.latestLedger || null;
    this.lastRun = new Date().toISOString();
    this.lastError = null;

    return {
      skipped: false,
      start_ledger: startLedger,
      latest_ledger: response.latestLedger,
      indexed_events: parsedEvents.length,
    };
  }

  start() {
    if (this.timer || !this.enabled) return;
    if (!this.contractId) {
      this.logger.warn('SmartDrop indexer disabled: SMARTDROP_CONTRACT_ID is not configured');
      return;
    }

    const run = async () => {
      try {
        const result = await this.pollOnce();
        this.logger.info('SmartDrop contract events indexed', result);
      } catch (err) {
        this.lastRun = new Date().toISOString();
        this.lastError = err.message;
        this.logger.warn('SmartDrop event indexing failed', { error: err.message });
      }
    };

    run();
    this.timer = setInterval(run, this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.info('SmartDrop event indexer started', {
      contractId: this.contractId,
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('SmartDrop event indexer stopped');
    }
  }
}

module.exports = { EventPoller };
