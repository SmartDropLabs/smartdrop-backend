'use strict';

/**
 * Dead-letter queue for permanently failed jobs (#623).
 *
 * An email that fails every retry must land in the dead-letter list so it can
 * be reviewed and re-sent, not silently disappear.
 */

const fakeRedis = {
  lists: new Map(),
  async lpush(key, value) {
    const list = this.lists.get(key) || [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  },
  async ltrim(key, start, stop) {
    const list = this.lists.get(key) || [];
    this.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  },
  async expire() {
    return 1;
  },
  async lrange(key, start, stop) {
    return (this.lists.get(key) || []).slice(start, stop + 1);
  },
};

jest.mock('../src/services/cache', () => ({
  getClient: () => fakeRedis,
}));
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const jobQueue = require('../src/services/jobQueue');
const { EMAIL_JOB_TYPE, getFailedEmails } = require('../src/services/emailQueue');

describe('job dead-letter queue (#623)', () => {
  beforeEach(() => {
    fakeRedis.lists.clear();
    jobQueue.handlers.clear();
  });

  function exhaustedJob(type, data) {
    return { id: `job_${type}`, type, data, attempts: 2, maxRetries: 3 };
  }

  test('an email that fails its last retry is dead-lettered with the error', async () => {
    jobQueue.register(EMAIL_JOB_TYPE, async () => {
      throw new Error('SMTP 550 mailbox unavailable');
    });

    await jobQueue._executeJob(exhaustedJob(EMAIL_JOB_TYPE, { to: 'a@b.co', subject: 'Hi' }));

    const failed = await getFailedEmails();
    expect(failed).toHaveLength(1);
    expect(failed[0].job.data).toEqual({ to: 'a@b.co', subject: 'Hi' });
    expect(failed[0].error).toBe('SMTP 550 mailbox unavailable');
    expect(typeof failed[0].failedAt).toBe('string');
  });

  test('a job with retries left is not dead-lettered', async () => {
    jest.useFakeTimers();
    try {
      jobQueue.register(EMAIL_JOB_TYPE, async () => {
        throw new Error('temporary');
      });
      await jobQueue._executeJob({ id: 'j', type: EMAIL_JOB_TYPE, data: {}, attempts: 0, maxRetries: 3 });

      expect(await getFailedEmails()).toHaveLength(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('getFailedEmails only returns email jobs', async () => {
    jobQueue.register('other-job', async () => {
      throw new Error('boom');
    });
    jobQueue.register(EMAIL_JOB_TYPE, async () => {
      throw new Error('bounce');
    });

    await jobQueue._executeJob(exhaustedJob('other-job', {}));
    await jobQueue._executeJob(exhaustedJob(EMAIL_JOB_TYPE, { to: 'x@y.z', subject: 'S' }));

    const failed = await getFailedEmails();
    expect(failed).toHaveLength(1);
    expect(failed[0].job.type).toBe(EMAIL_JOB_TYPE);
    expect(await jobQueue.getDeadLetters()).toHaveLength(2);
  });

  test('the dead-letter list is capped', async () => {
    jobQueue.register(EMAIL_JOB_TYPE, async () => {
      throw new Error('down');
    });
    for (let i = 0; i < jobQueue.DEAD_LETTER_MAX + 5; i++) {
      await jobQueue._executeJob(exhaustedJob(EMAIL_JOB_TYPE, { to: `${i}@x.y`, subject: 'S' }));
    }

    expect(fakeRedis.lists.get(jobQueue.DEAD_LETTER_KEY)).toHaveLength(jobQueue.DEAD_LETTER_MAX);
  });
});
