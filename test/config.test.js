'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');

function cleanProcessEnv(overrides) {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...overrides,
  };
}

function runConfig(script, env) {
  return spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: cleanProcessEnv(env),
    encoding: 'utf8',
  });
}

describe('configuration validation', () => {
  test('exits before startup and reports every invalid production variable', () => {
    const result = runConfig("require('./src/config')", {
      NODE_ENV: 'production',
      REDIS_URL: 'not-a-url',
      LOG_LEVEL: 'verbose',
      PRICE_CACHE_TTL_SECONDS: 'soon',
    });

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('REDIS_URL');
    expect(output).toContain('LOG_LEVEL');
    expect(output).toContain('PRICE_CACHE_TTL_SECONDS');
  });

  test('loads safe in-process defaults under NODE_ENV=test', () => {
    const result = runConfig(
      [
        "const config = require('./src/config');",
        'console.log(JSON.stringify({',
        '  port: config.port,',
        '  databaseUrl: config.databaseUrl,',
        '  redisUrl: config.redis.url,',
        '  price: config.price,',
        '}));',
      ].join(' '),
      { NODE_ENV: 'test' }
    );

    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual({
      port: 3000,
      databaseUrl: 'postgres://localhost/smartdrop_test',
      redisUrl: 'redis://localhost:6379',
      price: {
        cacheTtl: 60,
        refreshInterval: 30,
        staleThresholdMinutes: 5,
        anomalyThresholdPercent: 20,
        sourceRetryCount: 3,
      },
    });
  });
});
