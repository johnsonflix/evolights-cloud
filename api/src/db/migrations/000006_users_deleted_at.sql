-- 000006_users_deleted_at.sql
-- Soft delete for users. We never hard-delete because:
--   - Stripe still references the customer by user_id metadata
--   - device rows fk-cascade to users, and we don't want to lose audit history
--   - admin needs to be able to "restore" a user
-- All user-fetching queries must filter `where deleted_at is null` to hide
-- deleted users from the application; admin endpoints intentionally include
-- them.
alter table users add column if not exists deleted_at timestamptz;

-- Partial index: only the live users get an index entry, keeping it small.
-- This is the index used by the `where deleted_at is null` filter we add to
-- every user lookup.
create index if not exists users_deleted_at_idx on users(deleted_at) where deleted_at is null;
