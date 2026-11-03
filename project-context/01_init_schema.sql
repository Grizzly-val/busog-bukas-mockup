-- ============================================================================
-- Busog Bukas — database initialization (schema only)
-- Target: MySQL 8.0.16+ or MariaDB 10.4+ (InnoDB, utf8mb4)
-- Import order: 01_init_schema.sql, then 02_seed_data.sql
--
-- Safe to re-run: every table is dropped first (children before parents).
-- Table names are the ERD entities in snake_case, e.g. ProgramSession ->
-- program_session, BeneficiaryTimelineStatus -> beneficiary_timeline_status.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS busog_bukas
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE busog_bukas;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS ai_interpretation;
DROP TABLE IF EXISTS beneficiary_timeline_status;
DROP TABLE IF EXISTS nutritionist_record;
DROP TABLE IF EXISTS survey_answer;
DROP TABLE IF EXISTS session_record;
DROP TABLE IF EXISTS consent;
DROP TABLE IF EXISTS beneficiary_allergy;
DROP TABLE IF EXISTS beneficiary_alias;
DROP TABLE IF EXISTS beneficiary;
DROP TABLE IF EXISTS session_note;
DROP TABLE IF EXISTS timeline;
DROP TABLE IF EXISTS program_session;
DROP TABLE IF EXISTS program_nutritionist;
DROP TABLE IF EXISTS program;
DROP TABLE IF EXISTS status_reason_definition;
DROP TABLE IF EXISTS status_definition;
DROP TABLE IF EXISTS survey_question;
DROP TABLE IF EXISTS guardian;
DROP TABLE IF EXISTS allergy;
DROP TABLE IF EXISTS nutritionist;
DROP TABLE IF EXISTS organization;

SET FOREIGN_KEY_CHECKS = 1;

-- ----------------------------------------------------------------------------
-- Program setup
-- ----------------------------------------------------------------------------

CREATE TABLE organization (
  org_id       CHAR(36)     NOT NULL,
  name         VARCHAR(150) NOT NULL,
  photo        VARCHAR(255) NULL,                -- optional display photo (path/URL)
  description  TEXT         NOT NULL,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE nutritionist (
  nutritionist_id CHAR(36)     NOT NULL,
  name            VARCHAR(150) NOT NULL,
  credentials     VARCHAR(100) NULL,             -- e.g. 'RND'; may be unknown
  PRIMARY KEY (nutritionist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE program (
  program_id         CHAR(36)     NOT NULL,
  org_id             CHAR(36)     NOT NULL,
  title              VARCHAR(150) NOT NULL,
  location           VARCHAR(200) NOT NULL,
  description        TEXT         NOT NULL,      -- who the program serves
  start_date         DATE         NOT NULL,
  end_date           DATE         NOT NULL,
  max_beneficiaries  INT          NOT NULL,
  PRIMARY KEY (program_id),
  CONSTRAINT fk_program_org FOREIGN KEY (org_id) REFERENCES organization (org_id),
  CONSTRAINT ck_program_dates CHECK (end_date >= start_date),
  CONSTRAINT ck_program_max CHECK (max_beneficiaries > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A row here is what activates the nutritionist (clinical) tier for a program.
CREATE TABLE program_nutritionist (
  program_id      CHAR(36) NOT NULL,
  nutritionist_id CHAR(36) NOT NULL,
  PRIMARY KEY (program_id, nutritionist_id),
  CONSTRAINT fk_pn_program FOREIGN KEY (program_id) REFERENCES program (program_id),
  CONSTRAINT fk_pn_nutritionist FOREIGN KEY (nutritionist_id) REFERENCES nutritionist (nutritionist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Sessions and Timelines
-- ----------------------------------------------------------------------------

CREATE TABLE program_session (
  session_id    CHAR(36)  NOT NULL,
  program_id    CHAR(36)  NOT NULL,
  session_date  DATE      NOT NULL,
  submitted_at  DATETIME  NULL,                  -- NULL = not submitted yet
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_session_program_date (program_id, session_date),
  UNIQUE KEY uq_session_with_program (session_id, program_id),   -- target for composite FKs
  CONSTRAINT fk_session_program FOREIGN KEY (program_id) REFERENCES program (program_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A Timeline starts at a session and ends at the session nearest start + 14 days
-- (earlier session on a tie); the ending session also starts the next Timeline.
-- Dates and member sessions are derived from start/end session. A boundary session
-- belongs to two Timelines, so program_session carries no timeline_id.
CREATE TABLE timeline (
  timeline_id       CHAR(36) NOT NULL,
  program_id        CHAR(36) NOT NULL,
  seq               INT      NOT NULL,           -- 1, 2, 3 ... within the program
  start_session_id  CHAR(36) NOT NULL,
  end_session_id    CHAR(36) NOT NULL,
  closed_at         DATETIME NULL,               -- set when the ending session is submitted
  PRIMARY KEY (timeline_id),
  UNIQUE KEY uq_timeline_seq (program_id, seq),
  CONSTRAINT fk_timeline_program FOREIGN KEY (program_id) REFERENCES program (program_id),
  CONSTRAINT fk_timeline_start FOREIGN KEY (start_session_id) REFERENCES program_session (session_id),
  CONSTRAINT fk_timeline_end FOREIGN KEY (end_session_id) REFERENCES program_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE session_note (
  note_id     CHAR(36)     NOT NULL,
  session_id  CHAR(36)     NOT NULL,
  category    VARCHAR(50)  NOT NULL,             -- e.g. leftovers, incident, event, attendance
  note        TEXT         NOT NULL,
  PRIMARY KEY (note_id),
  CONSTRAINT fk_note_session FOREIGN KEY (session_id) REFERENCES program_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Beneficiaries (identity is (program_id, beneficiary_code))
-- ----------------------------------------------------------------------------

CREATE TABLE beneficiary (
  program_id             CHAR(36)    NOT NULL,
  beneficiary_code       CHAR(5)     NOT NULL,   -- 5-digit code, unique per program
  name                   VARCHAR(150) NULL,      -- optional; only stored with consent
  birth_month            TINYINT     NOT NULL,
  birth_year             SMALLINT    NOT NULL,
  sex                    ENUM('female','male') NOT NULL,
  registered_session_id  CHAR(36)    NOT NULL,   -- session where first seen (defines starting Timeline)
  PRIMARY KEY (program_id, beneficiary_code),
  CONSTRAINT fk_ben_program FOREIGN KEY (program_id) REFERENCES program (program_id),
  CONSTRAINT fk_ben_session FOREIGN KEY (registered_session_id, program_id)
    REFERENCES program_session (session_id, program_id),
  CONSTRAINT ck_ben_code CHECK (beneficiary_code REGEXP '^[0-9]{5}$'),
  CONSTRAINT ck_ben_month CHECK (birth_month BETWEEN 1 AND 12),
  CONSTRAINT ck_ben_year CHECK (birth_year BETWEEN 1900 AND 2100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mnemonic alias, only while name is NULL. Unique within a program.
CREATE TABLE beneficiary_alias (
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  alias             VARCHAR(60)  NOT NULL,
  PRIMARY KEY (program_id, beneficiary_code),
  UNIQUE KEY uq_alias_per_program (program_id, alias),
  CONSTRAINT fk_alias_ben FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE allergy (
  allergy_id  CHAR(36)     NOT NULL,
  name        VARCHAR(80)  NOT NULL,
  PRIMARY KEY (allergy_id),
  UNIQUE KEY uq_allergy_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE beneficiary_allergy (
  program_id        CHAR(36) NOT NULL,
  beneficiary_code  CHAR(5)  NOT NULL,
  allergy_id        CHAR(36) NOT NULL,
  PRIMARY KEY (program_id, beneficiary_code, allergy_id),
  CONSTRAINT fk_ba_ben FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),
  CONSTRAINT fk_ba_allergy FOREIGN KEY (allergy_id) REFERENCES allergy (allergy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE guardian (
  guardian_id  CHAR(36)     NOT NULL,
  name         VARCHAR(150) NOT NULL,
  `number`     VARCHAR(30)  NOT NULL,            -- contact number
  PRIMARY KEY (guardian_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Consent links a guardian to a beneficiary. A stored name needs a consent row
-- (minors) or the adult's own willingness (adults have no consent row).
CREATE TABLE consent (
  program_id        CHAR(36)    NOT NULL,
  beneficiary_code  CHAR(5)     NOT NULL,
  guardian_id       CHAR(36)    NOT NULL,
  relationship      VARCHAR(40) NOT NULL,        -- mother, father, grandmother, ...
  PRIMARY KEY (program_id, beneficiary_code, guardian_id),
  CONSTRAINT fk_consent_ben FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),
  CONSTRAINT fk_consent_guardian FOREIGN KEY (guardian_id) REFERENCES guardian (guardian_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Session inputs: Default, Nutritionist, Survey/Feedback
-- BMI, WHtR and WHO z-scores are computed, not stored.
-- ----------------------------------------------------------------------------

-- Default input. One row per registered beneficiary per submitted session:
-- is_present = TRUE rows are entered, FALSE rows come from the reconciliation pass.
CREATE TABLE session_record (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  is_present        BOOLEAN      NOT NULL DEFAULT FALSE,
  weight_kg         DECIMAL(5,1) NULL,
  height_cm         DECIMAL(5,1) NULL,
  waist_cm          DECIMAL(5,1) NULL,
  PRIMARY KEY (session_id, program_id, beneficiary_code),
  CONSTRAINT fk_sr_session FOREIGN KEY (session_id, program_id)
    REFERENCES program_session (session_id, program_id),
  CONSTRAINT fk_sr_ben FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE survey_question (
  question_id   VARCHAR(40) NOT NULL,            -- e.g. q_portion
  prompt_minor  TEXT        NOT NULL,            -- wording for minors
  prompt_adult  TEXT        NOT NULL,            -- wording for adults
  PRIMARY KEY (question_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Recorded with the session, counted per Timeline.
CREATE TABLE survey_answer (
  session_id        CHAR(36)    NOT NULL,
  program_id        CHAR(36)    NOT NULL,
  beneficiary_code  CHAR(5)     NOT NULL,
  question_id       VARCHAR(40) NOT NULL,
  `value`           TINYINT     NOT NULL,        -- 1 (low) to 5 (high)
  PRIMARY KEY (session_id, program_id, beneficiary_code, question_id),
  CONSTRAINT fk_sa_record FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),
  CONSTRAINT fk_sa_question FOREIGN KEY (question_id) REFERENCES survey_question (question_id),
  CONSTRAINT ck_sa_value CHECK (`value` BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional clinical check, at most one per beneficiary per session.
CREATE TABLE nutritionist_record (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  nutritionist_id   CHAR(36)     NOT NULL,
  muac_cm           DECIMAL(4,1) NULL,
  edema             BOOLEAN      NULL,
  clinical_notes    TEXT         NULL,
  PRIMARY KEY (session_id, program_id, beneficiary_code),
  CONSTRAINT fk_nr_record FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),
  CONSTRAINT fk_nr_nutritionist FOREIGN KEY (nutritionist_id) REFERENCES nutritionist (nutritionist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Status and AI
-- ----------------------------------------------------------------------------

CREATE TABLE status_definition (
  status_key   VARCHAR(30)  NOT NULL,            -- baseline | monitor | monitor_closely | unavailable
  description  VARCHAR(150) NOT NULL,
  criteria     TEXT         NULL,                -- numeric cutoffs are still open
  PRIMARY KEY (status_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE status_reason_definition (
  reason_key   VARCHAR(30)  NOT NULL,            -- normal | edema | muac | bmi | whtr | incomplete_data
  description  VARCHAR(150) NOT NULL,
  PRIMARY KEY (reason_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Written once, when the Timeline closes. Status = actual body composition in that
-- Timeline. *_change = signed change versus the previous Timeline (negative if
-- declined, positive if improved); NULL in the first Timeline or when either side
-- has no value. No row exists for a beneficiary with no Default input in the Timeline.
CREATE TABLE beneficiary_timeline_status (
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  timeline_id       CHAR(36)     NOT NULL,
  status_key        VARCHAR(30)  NOT NULL,
  status_reason     VARCHAR(30)  NOT NULL DEFAULT 'normal',
  bmi_change        DECIMAL(6,3) NULL,
  whtr_change       DECIMAL(6,3) NULL,
  muac_change       DECIMAL(6,3) NULL,
  PRIMARY KEY (program_id, beneficiary_code, timeline_id),
  CONSTRAINT fk_bts_ben FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),
  CONSTRAINT fk_bts_timeline FOREIGN KEY (timeline_id) REFERENCES timeline (timeline_id),
  CONSTRAINT fk_bts_status FOREIGN KEY (status_key) REFERENCES status_definition (status_key),
  CONSTRAINT fk_bts_reason FOREIGN KEY (status_reason) REFERENCES status_reason_definition (reason_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Timeline-scoped trend interpretations and session-scoped observations.
-- Exactly one of session_id / timeline_id is filled, matching scope.
CREATE TABLE ai_interpretation (
  interpretation_id  CHAR(36)     NOT NULL,
  scope              ENUM('session','timeline') NOT NULL,
  session_id         CHAR(36)     NULL,
  timeline_id        CHAR(36)     NULL,
  category           VARCHAR(50)  NOT NULL,      -- nutrition_trend, attendance_trend, feedback_trend, privacy_concern ...
  comments           TEXT         NOT NULL,
  created_at         DATETIME     NOT NULL,
  PRIMARY KEY (interpretation_id),
  CONSTRAINT fk_ai_session FOREIGN KEY (session_id) REFERENCES program_session (session_id),
  CONSTRAINT fk_ai_timeline FOREIGN KEY (timeline_id) REFERENCES timeline (timeline_id),
  CONSTRAINT ck_ai_scope CHECK (
    (scope = 'session'  AND session_id  IS NOT NULL AND timeline_id IS NULL) OR
    (scope = 'timeline' AND timeline_id IS NOT NULL AND session_id  IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
