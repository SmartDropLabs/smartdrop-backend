'use strict';

/**
 * Prometheus text exposition format generator and in-memory metrics registry (Issue #467).
 *
 * Implements:
 * - Counter, Gauge, Histogram
 * - HELP and TYPE lines
 * - Label escaping
 * - text/plain; version=0.0.4; charset=utf-8 output format
 */

function escapeLabelValue(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${formatted}}`;
}

class Counter {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.type = 'counter';
    this.values = new Map();
  }

  inc(labels = {}, value = 1) {
    if (value < 0) return;
    const key = JSON.stringify(labels);
    const current = this.values.get(key) || { labels, value: 0 };
    current.value += value;
    this.values.set(key, current);
  }

  get(labels = {}) {
    const key = JSON.stringify(labels);
    return (this.values.get(key) || { value: 0 }).value;
  }

  reset() {
    this.values.clear();
  }

  serialize() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.values.values()) {
        lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.type = 'gauge';
    this.values = new Map();
  }

  set(labels = {}, value) {
    const key = JSON.stringify(labels);
    this.values.set(key, { labels, value: Number(value) });
  }

  inc(labels = {}, value = 1) {
    const key = JSON.stringify(labels);
    const current = this.values.get(key) || { labels, value: 0 };
    current.value += value;
    this.values.set(key, current);
  }

  dec(labels = {}, value = 1) {
    this.inc(labels, -value);
  }

  get(labels = {}) {
    const key = JSON.stringify(labels);
    return (this.values.get(key) || { value: 0 }).value;
  }

  reset() {
    this.values.clear();
  }

  serialize() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.values.values()) {
        lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }
    return lines.join('\n');
  }
}

const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

class Histogram {
  constructor(name, help, options = {}) {
    this.name = name;
    this.help = help;
    this.type = 'histogram';
    this.buckets = options.buckets || DEFAULT_BUCKETS;
    this.entries = new Map();
  }

  observe(labels = {}, value) {
    const val = Number(value);
    const key = JSON.stringify(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      const bucketCounts = {};
      this.buckets.forEach((b) => {
        bucketCounts[b] = 0;
      });
      bucketCounts['+Inf'] = 0;
      entry = {
        labels,
        sum: 0,
        count: 0,
        bucketCounts,
      };
      this.entries.set(key, entry);
    }

    entry.sum += val;
    entry.count += 1;

    for (const b of this.buckets) {
      if (val <= b) {
        entry.bucketCounts[b] += 1;
      }
    }
    entry.bucketCounts['+Inf'] += 1;
  }

  reset() {
    this.entries.clear();
  }

  serialize() {
    const lines = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);

    if (this.entries.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
    } else {
      for (const entry of this.entries.values()) {
        const baseLabels = entry.labels;
        for (const b of this.buckets) {
          const bLabels = { ...baseLabels, le: String(b) };
          lines.push(
            `${this.name}_bucket${formatLabels(bLabels)} ${entry.bucketCounts[b]}`
          );
        }
        lines.push(
          `${this.name}_bucket${formatLabels({ ...baseLabels, le: '+Inf' })} ${entry.bucketCounts['+Inf']}`
        );
        lines.push(
          `${this.name}_sum${formatLabels(baseLabels)} ${Number(entry.sum.toFixed(6))}`
        );
        lines.push(
          `${this.name}_count${formatLabels(baseLabels)} ${entry.count}`
        );
      }
    }
    return lines.join('\n');
  }
}

class Registry {
  constructor() {
    this.metrics = new Map();
  }

  register(metric) {
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name, help) {
    if (this.metrics.has(name)) return this.metrics.get(name);
    const metric = new Counter(name, help);
    return this.register(metric);
  }

  gauge(name, help) {
    if (this.metrics.has(name)) return this.metrics.get(name);
    const metric = new Gauge(name, help);
    return this.register(metric);
  }

  histogram(name, help, options) {
    if (this.metrics.has(name)) return this.metrics.get(name);
    const metric = new Histogram(name, help, options);
    return this.register(metric);
  }

  getMetric(name) {
    return this.metrics.get(name);
  }

  reset() {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  serialize() {
    const blocks = [];
    for (const metric of this.metrics.values()) {
      blocks.push(metric.serialize());
    }
    return blocks.join('\n') + '\n';
  }
}

module.exports = {
  Registry,
  Counter,
  Gauge,
  Histogram,
  escapeLabelValue,
  formatLabels,
};
