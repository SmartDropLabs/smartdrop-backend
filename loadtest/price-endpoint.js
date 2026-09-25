// Minimal k6 load-test script for the price endpoint (Issue #219).
// Run with: k6 run loadtest/price-endpoint.js
// This is a starting point, not a full benchmark suite — webhook delivery
// latency and concurrent-connection limits are follow-up scripts.
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 10,
  duration: '30s',
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const res = http.get(`${BASE_URL}/prices/USDC`);
  check(res, { 'status is 200 or 404': (r) => r.status === 200 || r.status === 404 });
}
