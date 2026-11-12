-- ════════════════════════════════════════════════════════════════════════════
-- LEAD SHARING — a lead worked by more than one person.
--
-- owner_user_id stays the one person answerable for the lead; shared_with are
-- the teammates who see and work it alongside them.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE leads ADD COLUMN shared_with text[] NOT NULL DEFAULT '{}';

CREATE INDEX leads_shared_with_idx ON leads USING gin (shared_with) WHERE archived_at IS NULL;

-- A source or import that hands leads to several people either splits them
-- (round-robin, one owner each) or gives every lead to all of them.
ALTER TABLE lead_sources ADD COLUMN assign_mode text NOT NULL DEFAULT 'split' CHECK (assign_mode IN ('split', 'share'));
