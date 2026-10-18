'use strict';

const { EmailQueue } = require('../email/emailQueue');

describe('EmailQueue (#515)', () => {
  it('enqueues emails without blocking the caller and delivers asynchronously', async () => {
    const delivered = [];
    const queue = new EmailQueue({
      baseDelayMs: 0,
      sendMail: async (payload) => {
        delivered.push(payload);
      },
    });

    const receipt = queue.enqueue({
      to: 'user@example.com',
      subject: 'Airdrop Claimed',
      text: 'Your SmartDrop tokens have been sent.',
    });

    expect(receipt.id).toMatch(/^email_/);
    expect(receipt.status).toBe('queued');

    await queue.drain();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe('user@example.com');
    expect(queue.getStats()).toMatchObject({
      enqueued: 1,
      sent: 1,
      retried: 0,
      failed: 0,
      queued: 0,
    });
  });

  it('retries transient transport errors and succeeds before maxAttempts', async () => {
    let calls = 0;
    const queue = new EmailQueue({
      maxAttempts: 3,
      baseDelayMs: 1,
      sendMail: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('SMTP temporary timeout');
        }
      },
    });

    queue.enqueue({
      to: 'retry@example.com',
      subject: 'Retry Test',
    });

    await queue.drain();

    expect(calls).toBe(3);
    expect(queue.getStats()).toMatchObject({
      enqueued: 1,
      sent: 1,
      retried: 2,
      failed: 0,
      deadLetterCount: 0,
    });
  });

  it('moves permanently failing emails to deadLetter after exhausting retries', async () => {
    const queue = new EmailQueue({
      maxAttempts: 2,
      baseDelayMs: 1,
      sendMail: async () => {
        throw new Error('Mailbox unavailable');
      },
    });

    queue.enqueue({
      to: 'bounce@example.com',
      subject: 'Permanent Failure',
    });

    await queue.drain();

    expect(queue.getStats()).toMatchObject({
      enqueued: 1,
      sent: 0,
      retried: 1,
      failed: 1,
      deadLetterCount: 1,
    });
    expect(queue.deadLetter[0].lastError).toBe('Mailbox unavailable');
  });

  it('validates required recipient and subject fields', () => {
    const queue = new EmailQueue();
    expect(() => queue.enqueue({})).toThrow(/Recipient address/);
    expect(() => queue.enqueue({ to: 'user@example.com' })).toThrow(/Email subject/);
  });
});
