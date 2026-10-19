// Issue #483: Race conditions in concurrent updates
// Implements optimistic locking to prevent data corruption

import { Request, Response, NextFunction } from 'express';

export interface VersionedEntity {
  id: string;
  version: number;
  [key: string]: any;
}

export class OptimisticLockError extends Error {
  constructor(
    message: string,
    public readonly entityId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

/**
 * Optimistic locking middleware for preventing race conditions
 * 
 * Usage:
 * ```
 * router.patch('/airdrops/:id', optimisticLocking, async (req, res) => {
 *   // Update logic here
 * });
 * ```
 */
export const optimisticLocking = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const ifMatch = req.header('If-Match');

  if (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
    if (!ifMatch) {
      return res.status(428).json({
        error: 'Precondition Required',
        message: 'If-Match header is required for update operations',
        hint: 'Include the entity version in the If-Match header',
      });
    }

    // Store version for validation in the route handler
    req.expectedVersion = parseInt(ifMatch, 10);

    if (isNaN(req.expectedVersion)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid If-Match header value',
        hint: 'If-Match must be a valid integer version number',
      });
    }
  }

  next();
};

/**
 * Validate entity version matches expected version
 * Throws OptimisticLockError if versions don't match
 */
export function validateVersion(
  entity: VersionedEntity,
  expectedVersion: number,
): void {
  if (entity.version !== expectedVersion) {
    throw new OptimisticLockError(
      'Version mismatch - entity was modified by another request',
      entity.id,
      expectedVersion,
      entity.version,
    );
  }
}

/**
 * Increment entity version for updates
 */
export function incrementVersion(entity: VersionedEntity): VersionedEntity {
  return {
    ...entity,
    version: entity.version + 1,
  };
}

/**
 * Set ETag header with entity version
 */
export function setVersionHeader(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

/**
 * Database query helper with optimistic locking
 */
export class OptimisticLockingRepository {
  constructor(private db: any) {}

  /**
   * Update entity with version check
   */
  async updateWithLock<T extends VersionedEntity>(
    table: string,
    id: string,
    expectedVersion: number,
    updates: Partial<T>,
  ): Promise<T> {
    const result = await this.db.query(
      `UPDATE ${table}
       SET ${Object.keys(updates)
         .map((key, idx) => `${key} = $${idx + 3}`)
         .join(', ')}, 
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND version = $2
       RETURNING *`,
      [id, expectedVersion, ...Object.values(updates)],
    );

    if (result.rows.length === 0) {
      // Check if entity exists
      const existing = await this.db.query(
        `SELECT version FROM ${table} WHERE id = $1`,
        [id],
      );

      if (existing.rows.length === 0) {
        throw new Error(`Entity not found: ${id}`);
      }

      throw new OptimisticLockError(
        'Version mismatch - entity was modified',
        id,
        expectedVersion,
        existing.rows[0].version,
      );
    }

    return result.rows[0];
  }

  /**
   * Delete entity with version check
   */
  async deleteWithLock(
    table: string,
    id: string,
    expectedVersion: number,
  ): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM ${table}
       WHERE id = $1 AND version = $2
       RETURNING id`,
      [id, expectedVersion],
    );

    if (result.rows.length === 0) {
      const existing = await this.db.query(
        `SELECT version FROM ${table} WHERE id = $1`,
        [id],
      );

      if (existing.rows.length === 0) {
        throw new Error(`Entity not found: ${id}`);
      }

      throw new OptimisticLockError(
        'Version mismatch - entity was modified',
        id,
        expectedVersion,
        existing.rows[0].version,
      );
    }

    return true;
  }

  /**
   * Get entity with version
   */
  async getWithVersion<T extends VersionedEntity>(
    table: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      `SELECT * FROM ${table} WHERE id = $1`,
      [id],
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

/**
 * Error handler for optimistic lock failures
 */
export const optimisticLockErrorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (err instanceof OptimisticLockError) {
    return res.status(409).json({
      error: 'Conflict',
      message: err.message,
      entityId: err.entityId,
      expectedVersion: err.expectedVersion,
      actualVersion: err.actualVersion,
      hint: 'Fetch the latest version and retry your request',
    });
  }

  next(err);
};

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      expectedVersion?: number;
    }
  }
}
