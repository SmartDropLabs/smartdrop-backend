const METRIC_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const METRIC_SAMPLE_INTERVAL_MS = 60 * 1000; // 1 minute

const metricHistory = [];

let lastSampleAt = 0;

const COUNTER_METRICS = new Set([
  'http_requests_total',
  'http_errors_total',
  'webhook_deliveries_total',
  'webhook_delivery_errors_total',
  'price_cache_hits_total',
  'price_cache_misses_total',
]);

function recordMetricSnapshot(values, timestamp = Date.now()) {
  // Avoid recording samples too frequently.
  if (timestamp - lastSampleAt < METRIC_SAMPLE_INTERVAL_MS) {
    return;
  }

  lastSampleAt = timestamp;

  metricHistory.push({
    timestamp,
    values: { ...values },
  });

  // Retain only the most recent seven days.
  const cutoff = timestamp - METRIC_HISTORY_RETENTION_MS;

  while (
    metricHistory.length > 0 &&
    metricHistory[0].timestamp < cutoff
  ) {
    metricHistory.shift();
  }
}

function getIntervalMs(interval) {
  const intervals = {
    '1h': 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };

  const duration = intervals[interval];

  if (!duration) {
    throw new Error(`Unsupported aggregation interval: ${interval}`);
  }

  return duration;
}

function aggregate(metrics, interval) {
  const intervalMs = getIntervalMs(interval);
  const now = Date.now();
  const start = now - intervalMs;

  const relevantMetrics = metrics.filter(
    (sample) => sample.timestamp >= start && sample.timestamp <= now,
  );

  const buckets = new Map();

  for (const sample of relevantMetrics) {
    const bucketStart =
      Math.floor(sample.timestamp / intervalMs) * intervalMs;

    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, {
        timestamp: bucketStart,
        counters: {},
        gauges: {},
        gaugeSamples: {},
      });
    }

    const bucket = buckets.get(bucketStart);

    for (const [name, value] of Object.entries(sample.values)) {
      if (COUNTER_METRICS.has(name)) {
        // Counters are cumulative. We store the latest snapshot per bucket,
        // then calculate the delta from the preceding snapshot.
        bucket.counters[name] = value;
      } else {
        // Gauges represent point-in-time values, so average the samples
        // within each bucket.
        bucket.gauges[name] = (bucket.gauges[name] || 0) + value;
        bucket.gaugeSamples[name] =
          (bucket.gaugeSamples[name] || 0) + 1;
      }
    }
  }

  const sortedBuckets = [...buckets.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  // Convert counter snapshots to bucket-level increments.
  const previousCounters = {};

  for (const bucket of sortedBuckets) {
    for (const [name, value] of Object.entries(bucket.counters)) {
      const previous = previousCounters[name] ?? value;

      // Handle counter resets, such as a process restart.
      bucket.counters[name] =
        value >= previous ? value - previous : value;

      previousCounters[name] = value;
    }

    // Convert gauge totals into averages.
    for (const [name, total] of Object.entries(bucket.gauges)) {
      const count = bucket.gaugeSamples[name];

      bucket.gauges[name] = count > 0 ? total / count : 0;
    }

    delete bucket.gaugeSamples;
  }

  return {
    interval,
    generatedAt: new Date(now).toISOString(),
    windowStart: new Date(start).toISOString(),
    windowEnd: new Date(now).toISOString(),
    buckets: sortedBuckets.map((bucket) => ({
      timestamp: new Date(bucket.timestamp).toISOString(),
      counters: bucket.counters,
      gauges: bucket.gauges,
    })),
  };
}