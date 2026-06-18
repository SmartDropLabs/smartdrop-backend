const { Server } = require('stellar-sdk');
const config = require('../../config');
const logger = require('../../logger');

let server = null;

function getServer() {
  if (!server) {
    server = new Server(config.stellar.horizonUrl);
  }
  return server;
}

const XLM_ASSET = { native: true };

async function fetchPrice(assetCode, issuer) {
  try {
    const horizon = getServer();

    let base;
    let counter;

    if (!issuer || assetCode === 'XLM') {
      base = XLM_ASSET;
      counter = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA' };
    } else {
      base = { code: assetCode, issuer };
      counter = XLM_ASSET;
    }

    const orderBook = await horizon.orderbook(base, counter === XLM_ASSET ? undefined : counter).limit(1).call();

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
    const usdcIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335AX2OBFLDTQLNUEHRGPTM6RIA';
    const orderBook = await horizon
      .orderbook(XLM_ASSET, { code: 'USDC', issuer: usdcIssuer })
      .limit(1)
      .call();

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
