'use strict';

const Semaphore = require('../src/utils/semaphore');

describe('Semaphore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('acquire resolves immediately when under capacity', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    expect(sem.active).toBe(1);
    release();
    expect(sem.active).toBe(0);
  });

  test('acquire without a timeout rejects immediately when at capacity', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    await expect(sem.acquire(0)).rejects.toThrow('no permits available');
  });

  test('acquire with a timeout queues, then rejects once the timeout elapses', async () => {
    jest.useFakeTimers();
    const sem = new Semaphore(1);
    await sem.acquire();

    const pending = sem.acquire(1000);
    expect(sem.waiting).toBe(1);

    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('timed out after 1000ms');
    expect(sem.waiting).toBe(0);
  });

  test('a queued acquire is granted once a permit is released, before its timeout fires', async () => {
    jest.useFakeTimers();
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    const pending = sem.acquire(5000);
    release1();

    const release2 = await pending;
    expect(sem.active).toBe(1);
    release2();
    expect(sem.active).toBe(0);
  });

  // Issue #365: the timeout callback removed the entry from the queue but
  // never cleared entry.timer, so the (already-fired) Timeout object's
  // callback closure kept `entry` reachable a moment longer than necessary
  // via `entry.timer` pointing back at it.
  test('clears entry.timer once the timeout fires', async () => {
    jest.useFakeTimers();
    const sem = new Semaphore(1);
    await sem.acquire();

    const pending = sem.acquire(1000);
    const entry = sem._queue[0];
    expect(entry.timer).toBeDefined();

    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow();

    expect(entry.timer).toBeNull();
  });

  test('a timed-out entry is removed from the queue and does not affect a later release', async () => {
    jest.useFakeTimers();
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    const timedOut = sem.acquire(100);
    jest.advanceTimersByTime(100);
    await expect(timedOut).rejects.toThrow();
    expect(sem.waiting).toBe(0);

    // Releasing now must not resolve anything that already timed out, and
    // must not throw despite the queue being empty.
    expect(() => release1()).not.toThrow();
    expect(sem.active).toBe(0);
  });
});
