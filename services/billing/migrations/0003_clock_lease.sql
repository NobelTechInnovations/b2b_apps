-- The billing clock runs on one replica at a time. A lease row, not a
-- session advisory lock: it needs no connection held for the whole tick, and
-- it survives connection poolers that do not pin sessions.
CREATE TABLE IF NOT EXISTS clock_leases (
  name   text PRIMARY KEY,
  holder text NOT NULL,
  until  timestamptz NOT NULL
);
