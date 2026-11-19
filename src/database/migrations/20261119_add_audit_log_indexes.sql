-- Issue #660: Add indexes to audit_log table for efficient audit queries
-- 
-- These indexes prevent slow audit queries and performance degradation
-- when the audit log grows. They optimize common query patterns:
-- - Filtering by user_id
-- - Filtering by timestamp (for time-range queries)
-- - Filtering by resource and resource_id (for resource-specific audits)
-- - Filtering by action with timestamp ordering (for action-based reports)

-- User-based audit queries
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

-- Time-range audit queries
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);

-- Resource-specific audit queries
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource, resource_id);

-- Action-based queries with time ordering
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, timestamp DESC);

-- Composite index for common query pattern: user + time range
CREATE INDEX IF NOT EXISTS idx_audit_user_timestamp ON audit_log(user_id, timestamp DESC);

-- Comment on indexes for documentation
COMMENT ON INDEX idx_audit_user IS 'Optimizes queries filtering by user_id';
COMMENT ON INDEX idx_audit_timestamp IS 'Optimizes time-range queries on audit log';
COMMENT ON INDEX idx_audit_resource IS 'Optimizes resource-specific audit lookups';
COMMENT ON INDEX idx_audit_action IS 'Optimizes action-based audit reports with time ordering';
COMMENT ON INDEX idx_audit_user_timestamp IS 'Optimizes user activity timeline queries';
