'use strict';

/**
 * #617 — a password change must not reuse the current password or any of the
 * PASSWORD_HISTORY_DEPTH most recent ones.
 */

jest.mock('../src/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../src/auth/session', () => ({
  invalidateAllUserSessions: jest.fn(async () => 0),
}));

const AppError = require('../src/errors/AppError');
const {
  hashPassword,
  validatePasswordHistory,
  changePassword,
  PASSWORD_HISTORY_DEPTH,
} = require('../src/auth');

const CURRENT = 'CurrentPass1!';
const OLD = 'OlderPass2@';
const FRESH = 'BrandNewPass3#';

async function buildUserStore() {
  const user = { id: 'u1', password_hash: await hashPassword(CURRENT) };
  return {
    user,
    findById: jest.fn(async () => user),
    update: jest.fn(async (_id, fields) => ({ ...user, ...fields })),
  };
}

describe('validatePasswordHistory (#617)', () => {
  it('rejects a password matching a recent hash', async () => {
    const hashes = [await hashPassword(OLD)];
    await expect(validatePasswordHistory(OLD, hashes)).rejects.toBeInstanceOf(AppError);
    await expect(validatePasswordHistory(OLD, hashes)).rejects.toThrow(/recent password/);
  });

  it('accepts a password that matches none of them', async () => {
    const hashes = [await hashPassword(OLD)];
    await expect(validatePasswordHistory(FRESH, hashes)).resolves.toBeUndefined();
  });

  it('only looks back PASSWORD_HISTORY_DEPTH entries', async () => {
    const filler = await hashPassword('FillerPass9$');
    const hashes = Array(PASSWORD_HISTORY_DEPTH).fill(filler);
    hashes.push(await hashPassword(OLD));
    await expect(validatePasswordHistory(OLD, hashes)).resolves.toBeUndefined();
  });

  it('ignores a missing history', async () => {
    await expect(validatePasswordHistory(FRESH, undefined)).resolves.toBeUndefined();
  });
});

describe('changePassword with history (#617)', () => {
  it('rejects reusing the current password even without a history store', async () => {
    const store = await buildUserStore();
    await expect(changePassword('u1', CURRENT, CURRENT, store)).rejects.toThrow(/recent password/);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('rejects a password from the history store', async () => {
    const store = await buildUserStore();
    const historyStore = {
      getRecent: jest.fn(async () => [await hashPassword(OLD)]),
      add: jest.fn(async () => {}),
    };

    await expect(changePassword('u1', CURRENT, OLD, store, historyStore)).rejects.toThrow(
      /recent password/,
    );
    expect(historyStore.getRecent).toHaveBeenCalledWith('u1', PASSWORD_HISTORY_DEPTH);
    expect(store.update).not.toHaveBeenCalled();
    expect(historyStore.add).not.toHaveBeenCalled();
  });

  it('accepts a new password and records the retired hash', async () => {
    const store = await buildUserStore();
    const retiredHash = store.user.password_hash;
    const historyStore = {
      getRecent: jest.fn(async () => [await hashPassword(OLD)]),
      add: jest.fn(async () => {}),
    };

    await changePassword('u1', CURRENT, FRESH, store, historyStore);

    expect(store.update).toHaveBeenCalledTimes(1);
    expect(historyStore.add).toHaveBeenCalledWith('u1', retiredHash);
  });
});
