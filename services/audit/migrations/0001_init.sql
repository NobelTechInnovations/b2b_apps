CREATE TABLE audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  org_id text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  resource_id text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_sequence ON audit_events(org_id, sequence DESC);
CREATE INDEX audit_org_type ON audit_events(org_id, event_type, sequence DESC);
-- The service only inserts and reads. Reject accidental mutation, including
-- TRUNCATE. This is not protection against a database administrator disabling
-- triggers; independent backups/storage controls remain necessary.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_no_mutation BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
