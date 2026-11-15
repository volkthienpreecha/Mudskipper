-- Audits are stored per content version of the run (DECISIONS.md K-315): audit_id does not change when a run
-- is regenerated in place or re-published, but the ranking can, so a row is served only for its bundle_hash.
-- Rows from before this migration have '' and are never served (the next POST re-ranks and replaces them).
ALTER TABLE audits ADD COLUMN bundle_hash TEXT NOT NULL DEFAULT '';
