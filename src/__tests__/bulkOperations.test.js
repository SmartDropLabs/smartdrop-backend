'use strict';

const { BulkOperationsService } = require('../services/bulkOperations');

describe('BulkOperationsService (#522)', () => {
  let service;
  let mockStore;

  beforeEach(() => {
    service = new BulkOperationsService({ maxBatchSize: 5, concurrency: 2 });
    const records = new Map();
    let seq = 1;

    mockStore = {
      records,
      async create(data) {
        if (!data.name) throw new Error('name is required');
        const id = `item_${seq++}`;
        const rec = { id, ...data };
        records.set(id, rec);
        return rec;
      },
      async update(id, patch) {
        const existing = records.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...patch };
        records.set(id, updated);
        return updated;
      },
      async remove(id) {
        const existing = records.get(id);
        if (!existing) return null;
        records.delete(id);
        return existing;
      },
    };
  });

  it('executes bulkCreate and returns summary with all fulfilled items', async () => {
    const summary = await service.bulkCreate(
      [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }],
      mockStore
    );

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.results.map((r) => r.data.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('supports partial success in bulkUpdate and bulkDelete', async () => {
    const created = await service.bulkCreate(
      [{ name: 'One' }, { name: 'Two' }],
      mockStore
    );
    const id1 = created.results[0].data.id;

    const updateSummary = await service.bulkUpdate(
      [
        { id: id1, data: { name: 'One Updated' } },
        { id: 'missing_id', data: { name: 'Ghost' } },
      ],
      mockStore
    );

    expect(updateSummary.succeeded).toBe(1);
    expect(updateSummary.failed).toBe(1);
    expect(updateSummary.results[0].status).toBe('fulfilled');
    expect(updateSummary.results[1].status).toBe('rejected');

    const deleteSummary = await service.bulkDelete(
      [id1, 'missing_id'],
      mockStore
    );
    expect(deleteSummary.succeeded).toBe(1);
    expect(deleteSummary.failed).toBe(1);
  });

  it('enforces maxBatchSize and non-empty array validation', async () => {
    await expect(service.bulkCreate([], mockStore)).rejects.toThrow(
      /cannot be empty/
    );
    await expect(
      service.bulkCreate(
        [{ name: '1' }, { name: '2' }, { name: '3' }, { name: '4' }, { name: '5' }, { name: '6' }],
        mockStore
      )
    ).rejects.toThrow(/exceeds maximum batch size/);
  });

  it('returns HTTP 201 on full create and HTTP 207 on partial success via handlers', async () => {
    const handlers = service.createHandlers(mockStore);

    const makeRes = () => ({
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        return this;
      },
    });

    const resFull = makeRes();
    await handlers.create(
      { body: { items: [{ name: 'A' }, { name: 'B' }] } },
      resFull
    );
    expect(resFull.statusCode).toBe(201);
    expect(resFull.payload.succeeded).toBe(2);

    const resPartial = makeRes();
    await handlers.create(
      { body: { items: [{ name: 'C' }, {}] } },
      resPartial
    );
    expect(resPartial.statusCode).toBe(207);
    expect(resPartial.payload.succeeded).toBe(1);
    expect(resPartial.payload.failed).toBe(1);
  });
});
