const { Server } = require('stellar-sdk');
const config = require('../../config');
const logger = require('../../logger');
const { fetchWithRetry } = require('../../utils/fetchWithRetry');

let server = null;

function getServer() {
  if (!server) {
    server = new Server(config.stellar.horizonUrl);
  }
  return server;
}

const XLM_ASSET = { native: true };

function fetchOrderBook(horizon, base, counter, label) {
  return fetchWithRetry(
    () => horizon.orderbook(base, counter).limit(1).call(),
    { label },
    config.price?.sourceRetryCount
  );
}

async function fetchPrice(assetCode, issuer) {
  try {
    const horizon = getServer();

    let base;
    let counter;

    if (!issuer || assetCode === 'XLM') {
      base = XLM_ASSET;
      counter = { code: 'USDC', issuer: config.stellar.usdcIssuer };
    } else {
      base = { code: assetCode, issuer };
      counter = XLM_ASSET;
    }

    const orderBook = await fetchOrderBook(
      horizon,
      base,
      counter === XLM_ASSET ? undefined : counter,
      'stellar_dex orderbook'
    );

    if (!orderBook.bids || orderBook.bids.length === 0) {
      return null;
    }

    const bestBid = parseFloat(orderBook.bids[0].price);

    if (!issuer || assetCode === 'XLM') {
      const xlmUsdcPrice = bestBid;
      const xlmUsd = await getXlmUsdPrice(horizon);
      if (xlmUsd === null) return null;
      return xlmUsdcPrice * xlmUsd;
    }

    return bestBid;
  } catch (err) {
    logger.warn('Stellar DEX price fetch failed', { assetCode, issuer, error: err.message });
    return null;
  }
}

async function getXlmUsdPrice(horizon) {
  try {
    const usdcIssuer = config.stellar.usdcIssuer;
    const orderBook = await fetchOrderBook(
      horizon,
      XLM_ASSET,
      { code: 'USDC', issuer: usdcIssuer },
      'stellar_dex xlm_usdc'
    );

    if (!orderBook.bids || orderBook.bids.length === 0) {
      return null;
    }

    return parseFloat(orderBook.bids[0].price);
  } catch (err) {
    logger.warn('XLM/USDC price fetch failed', { error: err.message });
    return null;
  }
}

module.exports = { fetchPrice };
