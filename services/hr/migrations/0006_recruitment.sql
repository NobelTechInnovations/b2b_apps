-- ════════════════════════════════════════════════════════════════════════════
-- RECRUITMENT — job openings, the candidates who apply, their interviews and
-- offers. Lives in HR because a hire becomes an employee here, in the same
-- transaction; the Recruitment app keeps its own permissions and screens.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE jobs (
  id              text PRIMARY KEY,
  org_id          text NOT NULL,
  title           text NOT NULL,
  department_id   text REFERENCES departments (id) ON DELETE SET NULL,
  location        text,
  employment_type text NOT NULL DEFAULT 'full_time'
                    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern', 'consultant')),
  openings        integer NOT NULL DEFAULT 1 CHECK (openings BETWEEN 1 AND 500),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'on_hold', 'closed')),
  -- Listed on the public careers page while open.
  is_public       boolean NOT NULL DEFAULT true,
  description     text NOT NULL DEFAULT '',
  salary_range    text,
  closes_on       date,
  hiring_manager_id text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE INDEX jobs_org_idx ON jobs (org_id, status, created_at DESC);

CREATE TABLE candidates (
  id               text PRIMARY KEY,
  org_id           text NOT NULL,
  job_id           text NOT NULL,
  first_name       text NOT NULL,
  last_name        text,
  email            text,
  phone            text,
  source           text NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'careers_page', 'referral', 'linkedin', 'naukri', 'walk_in', 'agency', 'other')),
  stage            text NOT NULL DEFAULT 'applied'
                     CHECK (stage IN ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  rating           smallint CHECK (rating BETWEEN 1 AND 5),
  current_company  text,
  experience_years numeric(4,1),
  resume_url       text,
  cover_note       text,
  owner_id         text,
  rejected_reason  text,
  -- The offer, while there is one. Money in integer paise.
  offer_ctc_paise  bigint CHECK (offer_ctc_paise > 0),
  offer_joining_on date,
  offer_status     text CHECK (offer_status IN ('proposed', 'approved', 'accepted', 'declined')),
  offer_approved_by text,
  employee_id      text REFERENCES employees (id) ON DELETE SET NULL,
  applied_ip_hash  text,
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, job_id) REFERENCES jobs (org_id, id) ON DELETE CASCADE
);

-- One application per person per job.
CREATE UNIQUE INDEX candidates_job_email_key ON candidates (org_id, job_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX candidates_pipeline_idx ON candidates (org_id, job_id, stage);
CREATE INDEX candidates_recent_idx ON candidates (org_id, created_at DESC);

CREATE TABLE interviews (
  id             text PRIMARY KEY,
  org_id         text NOT NULL,
  candidate_id   text NOT NULL,
  scheduled_at   timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  mode           text NOT NULL DEFAULT 'video' CHECK (mode IN ('in_person', 'phone', 'video')),
  location       text,
  interviewer_id text NOT NULL,
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  rating         smallint CHECK (rating BETWEEN 1 AND 5),
  recommendation text CHECK (recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
  feedback       text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id) ON DELETE CASCADE
);

CREATE INDEX interviews_schedule_idx ON interviews (org_id, scheduled_at);
CREATE INDEX interviews_interviewer_idx ON interviews (org_id, interviewer_id, status);

-- Notes and the automatic history (stage moves, offers) on one timeline.
CREATE TABLE candidate_notes (
  id           text PRIMARY KEY,
  org_id       text NOT NULL,
  candidate_id text NOT NULL,
  kind         text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'event')),
  body         text NOT NULL,
  author_id    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, candidate_id) REFERENCES candidates (org_id, id) ON DELETE CASCADE
);

CREATE INDEX candidate_notes_idx ON candidate_notes (org_id, candidate_id, created_at);
