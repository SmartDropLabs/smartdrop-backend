'use strict';

const { ReadReplicaRouter } = require('../database/readReplicas');

describe('Read replicas (#514)', () => {
  describe('ReadReplicaRouter', () => {
    it('falls back to primary when no replicas configured', () => {
      const router = new ReadReplicaRouter({
        primary: 'postgres://primary',
        replicas: [],
      });
      // Don't call init() — just test the logic
      router.primary = { id: 'primary' };
      router.replicas = [];

      const replica = router.getReplica();
      expect(replica).toBe(router.primary);
    });

    it('round-robins across replicas', () => {
      const router = new ReadReplicaRouter({
        primary: 'postgres://primary',
        replicas: ['postgres://r1', 'postgres://r2', 'postgres://r3'],
      });
      router.primary = { id: 'primary' };
      router.replicas = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];

      const first = router.getReplica();
      const second = router.getReplica();
      const third = router.getReplica();
      const fourth = router.getReplica(); // wraps around

      expect(first.id).toBe('r1');
      expect(second.id).toBe('r2');
      expect(third.id).toBe('r3');
      expect(fourth.id).toBe('r1');
    });

    it('getPrimary returns the primary connection', () => {
      const router = new ReadReplicaRouter({
        primary: 'postgres://primary',
        replicas: [],
      });
      router.primary = { id: 'primary' };

      expect(router.getPrimary()).toBe(router.primary);
    });

    it('read() routes to a replica', async () => {
      const router = new ReadReplicaRouter({
        primary: 'postgres://primary',
        replicas: ['postgres://r1'],
      });
      router.primary = { id: 'primary' };
      router.replicas = [{ id: 'r1' }];

      const callback = jest.fn().mockResolvedValue('result');
      const result = await router.read(callback);
      expect(result).toBe('result');
      expect(callback).toHaveBeenCalledWith(router.replicas[0]);
    });

    it('write() routes to primary', async () => {
      const router = new ReadReplicaRouter({
        primary: 'postgres://primary',
        replicas: ['postgres://r1'],
      });
      router.primary = { id: 'primary' };
      router.replicas = [{ id: 'r1' }];

      const callback = jest.fn().mockResolvedValue('result');
      const result = await router.write(callback);
      expect(result).toBe('result');
      expect(callback).toHaveBeenCalledWith(router.primary);
    });
  });

  describe('createFromEnv', () => {
    it('creates router from env vars', () => {
      process.env.DATABASE_URL = 'postgres://primary';
      process.env.DATABASE_REPLICA_URLS = 'postgres://r1,postgres://r2';

      const { createFromEnv } = require('../database/readReplicas');
      const router = createFromEnv();
      expect(router.replicaConfigs).toEqual(['postgres://r1', 'postgres://r2']);

      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_REPLICA_URLS;
    });
  });
});
