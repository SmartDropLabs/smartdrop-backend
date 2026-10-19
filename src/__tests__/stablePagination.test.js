'use strict';

const { encodeCursor, decodeCursor, applyCursor, buildPage } = require('../utils/stablePagination');

describe('Stable pagination cursors (#513)', () => {
  describe('encodeCursor / decodeCursor', () => {
    it('round-trips a cursor', () => {
      const cursor = encodeCursor('2024-01-15T10:30:00Z', 42);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({ sortValue: '2024-01-15T10:30:00Z', rowId: 42 });
    });

    it('returns null for invalid cursor', () => {
      expect(decodeCursor('invalid-base64')).toBeNull();
      expect(decodeCursor('')).toBeNull();
    });

    it('returns null for cursor missing fields', () => {
      const bad = Buffer.from(JSON.stringify({ x: 1 })).toString('base64url');
      expect(decodeCursor(bad)).toBeNull();
    });
  });

  describe('buildPage', () => {
    it('returns all items when fewer than limit', () => {
      const rows = [
        { created_at: '2024-01-01', id: 1 },
        { created_at: '2024-01-02', id: 2 },
      ];
      const page = buildPage(rows, { sortColumn: 'created_at', idColumn: 'id', limit: 10 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });

    it('truncates to limit and returns nextCursor', () => {
      const rows = [
        { created_at: '2024-01-01', id: 1 },
        { created_at: '2024-01-02', id: 2 },
        { created_at: '2024-01-03', id: 3 },
      ];
      const page = buildPage(rows, { sortColumn: 'created_at', idColumn: 'id', limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeDefined();

      const decoded = decodeCursor(page.nextCursor);
      expect(decoded).toEqual({ sortValue: '2024-01-02', rowId: 2 });
    });

    it('returns empty page for empty input', () => {
      const page = buildPage([], { sortColumn: 'created_at', idColumn: 'id', limit: 10 });
      expect(page.items).toHaveLength(0);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });

  describe('applyCursor', () => {
    it('applies keyset condition when cursor is provided', () => {
      const mockQuery = {
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
      };

      const cursor = encodeCursor('2024-01-02', 2);
      applyCursor(mockQuery, {
        sortColumn: 'created_at',
        idColumn: 'id',
        direction: 'desc',
        cursor,
        limit: 10,
      });

      expect(mockQuery.orderBy).toHaveBeenCalledWith('created_at', 'desc');
      expect(mockQuery.orderBy).toHaveBeenCalledWith('id', 'desc');
      expect(mockQuery.where).toHaveBeenCalled();
      expect(mockQuery.limit).toHaveBeenCalledWith(11); // limit + 1 for hasMore
    });

    it('skips keyset condition on first page (no cursor)', () => {
      const mockQuery = {
        orderBy: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
      };

      applyCursor(mockQuery, {
        sortColumn: 'created_at',
        idColumn: 'id',
        direction: 'desc',
        cursor: null,
        limit: 10,
      });

      expect(mockQuery.where).not.toHaveBeenCalled();
    });
  });
});
