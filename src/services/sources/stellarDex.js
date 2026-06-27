const { Server } = require('stellar-sdk');
const config = require('../../config');

let server = null;

function getServer() {
  if (!server) {
    server = new Server(config.stellar.horizonUrl);
  }
  return server;
}

const XLM_ASSET = { native: true };

function derivePriceFromOrderbook(orderBook) {
  const asks = orderBook.asks ?? [];
  const bids = orderBook.bids ?? [];

  const hasAsks = asks.length > 0;
  const hasBids = bids.length > 0;

  if (!hasAsks && !hasBids) {
    return null;
  }

  if (hasAsks && hasBids) {
    const bestAsk = parseFloat(asks[0].price);
    const bestBid = parseFloat(bids[0].price);
    return (bestAsk + bestBid) / 2;
  }

  if (hasBids) {
    return parseFloat(bids[0].price);
  }

  return parseFloat(asks[0].price);
}

async function fetchPrice(assetCode, issuer) {
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

  const orderBook = await horizon
    .orderbook(base, counter === XLM_ASSET ? undefined : counter)
    .limit(1)
    .call();

  return derivePriceFromOrderbook(orderBook);
}

module.exports = { fetchPrice, derivePriceFromOrderbook };
