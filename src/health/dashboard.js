'use strict';

/**
 * Health check dashboard (#580): one page that shows liveness, dependency
 * readiness and background-job health together, instead of an operator
 * having to query /health/live, /health/ready and /health/jobs separately.
 *
 * It renders only data those endpoints already expose publicly — no
 * credentials, connection strings or stack traces — and uses no inline
 * scripts or styles, so it works under the API's `default-src 'none'` CSP.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDetail(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Builds the dashboard data shared by the HTML and JSON views.
 *
 * @param {{ status: string, dependencies: Object }} readiness
 * @param {{ jobHealth: Object, allHealthy: boolean }} jobs
 */
function buildSummary(readiness, jobs) {
  const dependencies = Object.entries(readiness.dependencies || {}).map(
    ([name, result]) => ({
      name,
      status: result.status,
      latencyMs: result.latencyMs,
    }),
  );
  const jobRows = Object.entries(jobs.jobHealth || {}).map(([name, health]) => {
    const { healthy, ...details } = health || {};
    return { name, healthy: healthy === true, details };
  });
  const healthy = readiness.status === 'ok' && jobs.allHealthy;
  return {
    status: healthy ? 'ok' : 'unhealthy',
    liveness: 'ok',
    dependencies,
    jobs: jobRows,
  };
}

function renderDashboard(summary, generatedAt = new Date()) {
  const dependencyRows = summary.dependencies
    .map(
      (dep) =>
        `<tr><td>${escapeHtml(dep.name)}</td><td>${escapeHtml(dep.status)}</td>` +
        `<td>${escapeHtml(formatDetail(dep.latencyMs))}</td></tr>`,
    )
    .join('');
  const jobRows = summary.jobs.length
    ? summary.jobs
        .map((job) => {
          const details = Object.entries(job.details)
            .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(formatDetail(value))}`)
            .join(', ');
          return (
            `<tr><td>${escapeHtml(job.name)}</td><td>${job.healthy ? 'healthy' : 'unhealthy'}</td>` +
            `<td>${details || '—'}</td></tr>`
          );
        })
        .join('')
    : '<tr><td colspan="3">No background jobs registered</td></tr>';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>SmartDrop health</title></head>',
    '<body>',
    '<h1>SmartDrop health</h1>',
    `<p>Overall status: <strong>${escapeHtml(summary.status)}</strong></p>`,
    `<p>Liveness: ${escapeHtml(summary.liveness)}</p>`,
    '<h2>Dependencies</h2>',
    '<table><thead><tr><th>Dependency</th><th>Status</th><th>Latency (ms)</th></tr></thead>',
    `<tbody>${dependencyRows}</tbody></table>`,
    '<h2>Background jobs</h2>',
    '<table><thead><tr><th>Job</th><th>Status</th><th>Details</th></tr></thead>',
    `<tbody>${jobRows}</tbody></table>`,
    `<p>Generated at ${escapeHtml(generatedAt.toISOString())}</p>`,
    '</body>',
    '</html>',
  ].join('\n');
}

module.exports = {
  buildSummary,
  escapeHtml,
  renderDashboard,
};
