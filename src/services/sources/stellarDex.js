const { Asset, Horizon } = require('stellar-sdk');
const config = require('../../config');
const logger = require('../../logger');

let server = null;

function getServer() {
  if (!server) {
    server = new Horizon.Server(config.stellar.horizonUrl);
  }
  return server;
}

function xlmAsset() {
  return Asset.native();
}

function usdcAsset() {
  return new Asset('USDC', config.stellar.usdcIssuer);
}

function issuedAsset(assetCode, issuer) {
  return new Asset(assetCode, issuer);
}

function midpointFromOrderBook(orderBook) {
  const bidPrice = orderBook.bids?.[0]?.price;
  const askPrice = orderBook.asks?.[0]?.price;
  const bestBid = bidPrice !== undefined ? parseFloat(bidPrice) : null;
  const bestAsk = askPrice !== undefined ? parseFloat(askPrice) : null;
  const hasBid = Number.isFinite(bestBid) && bestBid > 0;
  const hasAsk = Number.isFinite(bestAsk) && bestAsk > 0;

  if (hasBid && hasAsk) return (bestBid + bestAsk) / 2;
  if (hasBid) return bestBid;
  if (hasAsk) return bestAsk;
  return null;
}

async function fetchOrderBookMidpoint(horizon, base, counter) {
  const orderBook = await horizon.orderbook(base, counter).limit(1).call();
  return midpointFromOrderBook(orderBook);
}

async function fetchPrice(assetCode, issuer) {
  try {
    const horizon = getServer();
    const normalizedCode = assetCode.toUpperCase();

    if (!issuer && normalizedCode !== 'XLM') {
      logger.debug('Stellar DEX issuer required for issued asset', { assetCode });
      return null;
    }

    if (normalizedCode === 'XLM') {
      return await fetchOrderBookMidpoint(horizon, xlmAsset(), usdcAsset());
    }

    const assetInXlm = await fetchOrderBookMidpoint(
      horizon,
      issuedAsset(normalizedCode, issuer),
      xlmAsset()
    );
    if (assetInXlm === null) return null;

    const xlmUsd = await getXlmUsdPrice(horizon);
    if (xlmUsd === null) return null;
    return assetInXlm * xlmUsd;
  } catch (err) {
    logger.warn('Stellar DEX price fetch failed', { assetCode, issuer, error: err.message });
    throw err;
  }
}

async function getXlmUsdPrice(horizon) {
  try {
    return await fetchOrderBookMidpoint(horizon, xlmAsset(), usdcAsset());
  } catch (err) {
    logger.warn('XLM/USDC price fetch failed', { error: err.message });
    throw err;
  }
}

module.exports = { fetchPrice };
