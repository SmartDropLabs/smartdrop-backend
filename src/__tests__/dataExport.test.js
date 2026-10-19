'use strict';

const { generateExport } = require('../export/dataExportService');

describe('Data export (#511)', () => {
  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
    username: 'testuser',
    password_hash: 'secret-hash',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  };

  it('generates export with profile data', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(mockUser) },
    };

    const result = await generateExport('user-1', stores);
    expect(result.profile.email).toBe('test@example.com');
    expect(result.profile.username).toBe('testuser');
    expect(result.export_metadata.user_id).toBe('user-1');
    expect(result.export_metadata.format_version).toBe('1.0');
  });

  it('strips sensitive fields from profile', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(mockUser) },
    };

    const result = await generateExport('user-1', stores);
    expect(result.profile.password_hash).toBeUndefined();
    expect(result.profile.password).toBeUndefined();
  });

  it('includes airdrops when airdropStore is provided', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(mockUser) },
      airdropStore: {
        findByUser: jest.fn().mockResolvedValue([
          { id: 'drop-1', name: 'Test Drop', status: 'completed', total_amount: 100, created_at: '2024-01-01' },
        ]),
      },
    };

    const result = await generateExport('user-1', stores);
    expect(result.airdrops).toHaveLength(1);
    expect(result.airdrops[0].name).toBe('Test Drop');
  });

  it('includes transactions when transactionStore is provided', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(mockUser) },
      transactionStore: {
        findByUser: jest.fn().mockResolvedValue([
          { id: 'tx-1', type: 'deposit', amount: 50, asset: 'USDC', status: 'confirmed', created_at: '2024-01-01' },
        ]),
      },
    };

    const result = await generateExport('user-1', stores);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].type).toBe('deposit');
  });

  it('throws when user not found', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(null) },
    };

    await expect(generateExport('nonexistent', stores)).rejects.toThrow('User not found');
  });

  it('handles missing optional stores gracefully', async () => {
    const stores = {
      userStore: { findByIdentifier: jest.fn().mockResolvedValue(mockUser) },
    };

    const result = await generateExport('user-1', stores);
    expect(result.airdrops).toEqual([]);
    expect(result.transactions).toEqual([]);
    expect(result.activity_log).toEqual([]);
  });
});
