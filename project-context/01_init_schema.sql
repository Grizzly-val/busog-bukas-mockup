-- ============================================================================
-- Busog Bukas — database initialization (schema only)
-- Target: MySQL 8.0.16+ or MariaDB 10.4+
-- Engine: InnoDB | Character set: utf8mb4
--
-- Import order: 01_init_schema.sql, then 02_seed_data.sql
-- Import with the mysql CLI: this file uses DELIMITER for a procedure and
-- triggers, which some GUI tools and drivers do not handle.
--
-- Safe to re-run: views and tables are dropped child-first before recreation.
--
-- Architecture:
--   * No timeline entity or timeline foreign keys.
--   * Program weeks are stored explicitly in program_week, with fixed
--     Sunday-Saturday boundaries. Week 1 starts at program.start_date and ends
--     on that week's Saturday; week 2+ starts Sunday and ends Saturday. The
--     final week may be shorter.
--   * Every program_session belongs to a program_week through week_id; a
--     trigger checks that session_date falls inside that week.
--   * Nutritional status is stored PER METRIC in four tables:
--       beneficiary_bmi_status, beneficiary_whtr_status,
--       beneficiary_muac_status, beneficiary_edema_status.
--     A row exists only for a (session, beneficiary) where that metric was
--     actually measured. History is kept (insert-only per session, upserted
--     on re-entry within the same session). "Latest" is the row with the
--     newest program_session.session_date, never the newest session_id.
--   * There is no stored overall status, no "unavailable" status and no stored
--     "outdated" flag. "No status for a metric" = no row in that metric's
--     table. "Outdated" and "last measured X sessions ago" are computed in
--     application code (see invariants at the end of this file).
--   * Program-wide readers use the v_latest_* views, which only look at
--     SUBMITTED sessions.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS busog_bukas
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE busog_bukas;

SET NAMES utf8mb4;

DROP VIEW IF EXISTS v_latest_metric_status;
DROP VIEW IF EXISTS v_latest_edema_status;
DROP VIEW IF EXISTS v_latest_muac_status;
DROP VIEW IF EXISTS v_latest_whtr_status;
DROP VIEW IF EXISTS v_latest_bmi_status;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS ai_interpretation;
DROP TABLE IF EXISTS beneficiary_edema_status;
DROP TABLE IF EXISTS beneficiary_muac_status;
DROP TABLE IF EXISTS beneficiary_whtr_status;
DROP TABLE IF EXISTS beneficiary_bmi_status;
DROP TABLE IF EXISTS nutritionist_record;
DROP TABLE IF EXISTS survey_answer;
DROP TABLE IF EXISTS session_record;
DROP TABLE IF EXISTS consent;
DROP TABLE IF EXISTS beneficiary_allergy;
DROP TABLE IF EXISTS beneficiary_alias;
DROP TABLE IF EXISTS beneficiary;
DROP TABLE IF EXISTS session_note;
DROP TABLE IF EXISTS program_session;
DROP TABLE IF EXISTS program_week;
DROP TABLE IF EXISTS program_nutritionist;
DROP TABLE IF EXISTS program;
DROP TABLE IF EXISTS status_definition;
DROP TABLE IF EXISTS survey_question;
DROP TABLE IF EXISTS guardian;
DROP TABLE IF EXISTS allergy;
DROP TABLE IF EXISTS nutritionist;
DROP TABLE IF EXISTS organization;

-- Remove legacy objects when reinitializing an older schema.
DROP TABLE IF EXISTS beneficiary_status_trigger;
DROP TABLE IF EXISTS beneficiary_status_record;
DROP TABLE IF EXISTS status_reason_definition;
DROP TABLE IF EXISTS beneficiary_timeline_status;
DROP TABLE IF EXISTS timeline;

SET FOREIGN_KEY_CHECKS = 1;


-- ============================================================================
-- PROGRAM SETUP
-- ============================================================================

CREATE TABLE organization (
  org_id       CHAR(36)     NOT NULL,
  name         VARCHAR(150) NOT NULL,
  photo        VARCHAR(255) NULL,
  description  TEXT         NOT NULL,
  PRIMARY KEY (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE nutritionist (
  nutritionist_id CHAR(36)     NOT NULL,
  name            VARCHAR(150) NOT NULL,
  credentials     VARCHAR(100) NULL,
  PRIMARY KEY (nutritionist_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE program (
  program_id         CHAR(36)     NOT NULL,
  org_id             CHAR(36)     NOT NULL,
  title              VARCHAR(150) NOT NULL,
  location           VARCHAR(200) NOT NULL,
  description        TEXT         NOT NULL,
  start_date         DATE         NOT NULL,
  end_date           DATE         NOT NULL,
  max_beneficiaries  INT          NOT NULL,

  PRIMARY KEY (program_id),

  CONSTRAINT fk_program_org
    FOREIGN KEY (org_id)
    REFERENCES organization (org_id),

  CONSTRAINT ck_program_dates
    CHECK (end_date >= start_date),

  CONSTRAINT ck_program_max
    CHECK (max_beneficiaries > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- PROGRAM WEEKS
-- Example:
--   Program start: 2026-09-22 (Tuesday)   Program end: 2026-10-19
--   Week 1: 2026-09-22 - 2026-09-26
--   Week 2: 2026-09-27 - 2026-10-03
--   Week 3: 2026-10-04 - 2026-10-10
--   Week 4: 2026-10-11 - 2026-10-17
--   Week 5: 2026-10-18 - 2026-10-19
--
-- Create the weeks (generate_program_weeks) before creating program sessions.
-- ============================================================================

CREATE TABLE program_week (
  week_id          CHAR(36) NOT NULL,
  program_id       CHAR(36) NOT NULL,
  week_number      INT      NOT NULL,
  week_start_date  DATE     NOT NULL,
  week_end_date    DATE     NOT NULL,

  PRIMARY KEY (week_id),

  UNIQUE KEY uq_program_week_number (program_id, week_number),
  UNIQUE KEY uq_program_week_start (program_id, week_start_date),

  -- Referenced key for the composite foreign key from program_session.
  UNIQUE KEY uq_program_week_id_program (week_id, program_id),

  KEY idx_program_week_dates (program_id, week_start_date, week_end_date),

  CONSTRAINT fk_week_program
    FOREIGN KEY (program_id)
    REFERENCES program (program_id),

  CONSTRAINT ck_week_number
    CHECK (week_number > 0),

  CONSTRAINT ck_week_dates
    CHECK (week_end_date >= week_start_date),

  CONSTRAINT ck_week_duration
    CHECK (DATEDIFF(week_end_date, week_start_date) <= 6),

  -- Week 1 may begin on the program start date; every later week begins Sunday.
  CONSTRAINT ck_week_start_boundary
    CHECK (week_number = 1 OR DAYOFWEEK(week_start_date) = 1)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Generate fixed Sunday-Saturday weeks for an existing program.
DROP PROCEDURE IF EXISTS generate_program_weeks;

DELIMITER //
CREATE PROCEDURE generate_program_weeks(IN p_program_id CHAR(36))
BEGIN
  DECLARE v_start DATE;
  DECLARE v_end DATE;
  DECLARE v_week_start DATE;
  DECLARE v_week_end DATE;
  DECLARE v_week_number INT DEFAULT 1;

  SELECT start_date, end_date
    INTO v_start, v_end
    FROM program
   WHERE program_id = p_program_id
   LIMIT 1;

  IF v_start IS NULL OR v_end IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Program not found';
  END IF;

  SET v_week_start = v_start;
  WHILE v_week_start <= v_end DO
    IF v_week_number = 1 THEN
      SET v_week_end = LEAST(
        DATE_ADD(v_start, INTERVAL (7 - DAYOFWEEK(v_start)) DAY),
        v_end
      );
    ELSE
      SET v_week_end = LEAST(DATE_ADD(v_week_start, INTERVAL 6 DAY), v_end);
    END IF;

    INSERT INTO program_week (
      week_id, program_id, week_number, week_start_date, week_end_date
    )
    VALUES (UUID(), p_program_id, v_week_number, v_week_start, v_week_end);

    SET v_week_start = DATE_ADD(v_week_end, INTERVAL 1 DAY);
    SET v_week_number = v_week_number + 1;
  END WHILE;
END//
DELIMITER ;


-- A row here activates the nutritionist (clinical) tier for a program.
-- Without a row, MUAC / edema inputs and statuses are disabled for the program.
CREATE TABLE program_nutritionist (
  program_id      CHAR(36) NOT NULL,
  nutritionist_id CHAR(36) NOT NULL,

  PRIMARY KEY (program_id, nutritionist_id),

  CONSTRAINT fk_pn_program
    FOREIGN KEY (program_id)
    REFERENCES program (program_id),

  CONSTRAINT fk_pn_nutritionist
    FOREIGN KEY (nutritionist_id)
    REFERENCES nutritionist (nutritionist_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- PROGRAM SESSIONS
-- ============================================================================

CREATE TABLE program_session (
  session_id    CHAR(36) NOT NULL,
  program_id    CHAR(36) NOT NULL,
  week_id       CHAR(36) NOT NULL,
  session_date  DATE     NOT NULL,
  submitted_at  DATETIME NULL,

  PRIMARY KEY (session_id),

  -- A program cannot have two sessions on the same date.
  UNIQUE KEY uq_session_program_date (program_id, session_date),

  -- Supports composite foreign keys from other tables.
  UNIQUE KEY uq_session_with_program (session_id, program_id),

  KEY idx_session_program_week_date (program_id, week_id, session_date),
  KEY idx_session_program_submitted_date (program_id, submitted_at, session_date),

  CONSTRAINT fk_session_program
    FOREIGN KEY (program_id)
    REFERENCES program (program_id),

  -- Ensures the selected week belongs to the same program.
  CONSTRAINT fk_session_week
    FOREIGN KEY (week_id, program_id)
    REFERENCES program_week (week_id, program_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- A foreign key cannot check that session_date lies inside the selected week,
-- so these triggers do. Weekly analytics trust week_id.
DELIMITER //
CREATE TRIGGER trg_session_week_bi
BEFORE INSERT ON program_session
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM program_week w
     WHERE w.week_id = NEW.week_id
       AND w.program_id = NEW.program_id
       AND NEW.session_date BETWEEN w.week_start_date AND w.week_end_date
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'session_date is outside the selected program_week';
  END IF;
END//

CREATE TRIGGER trg_session_week_bu
BEFORE UPDATE ON program_session
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM program_week w
     WHERE w.week_id = NEW.week_id
       AND w.program_id = NEW.program_id
       AND NEW.session_date BETWEEN w.week_start_date AND w.week_end_date
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'session_date is outside the selected program_week';
  END IF;
END//
DELIMITER ;


-- ============================================================================
-- SESSION NOTES
-- ============================================================================

CREATE TABLE session_note (
  note_id     CHAR(36)    NOT NULL,
  session_id  CHAR(36)    NOT NULL,
  category    VARCHAR(50) NOT NULL,
  note        TEXT        NOT NULL,

  PRIMARY KEY (note_id),

  KEY idx_note_session (session_id),

  CONSTRAINT fk_note_session
    FOREIGN KEY (session_id)
    REFERENCES program_session (session_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- BENEFICIARIES
-- Identity is (program_id, beneficiary_code).
--
-- initial_weight_kg / initial_height_cm are the registration measurements.
-- They are ALSO written into the registration session's session_record. While
-- the registration session is still a draft, any edit to that session's
-- weight/height for this beneficiary must also update initial_* (write-through).
-- ============================================================================

CREATE TABLE beneficiary (
  program_id             CHAR(36)     NOT NULL,
  beneficiary_code       CHAR(5)      NOT NULL,
  name                   VARCHAR(150) NULL,
  birth_month            TINYINT      NOT NULL,
  birth_year             SMALLINT     NOT NULL,
  sex                    ENUM('female','male') NOT NULL,
  initial_weight_kg      DECIMAL(5,1) NOT NULL,
  initial_height_cm      DECIMAL(5,1) NOT NULL,
  registered_session_id  CHAR(36)     NOT NULL,

  PRIMARY KEY (program_id, beneficiary_code),

  KEY idx_ben_registered_session (registered_session_id, program_id),

  CONSTRAINT fk_ben_program
    FOREIGN KEY (program_id)
    REFERENCES program (program_id),

  CONSTRAINT fk_ben_registered_session
    FOREIGN KEY (registered_session_id, program_id)
    REFERENCES program_session (session_id, program_id),

  CONSTRAINT ck_ben_code
    CHECK (beneficiary_code REGEXP '^[0-9]{5}$'),

  CONSTRAINT ck_ben_month
    CHECK (birth_month BETWEEN 1 AND 12),

  CONSTRAINT ck_ben_year
    CHECK (birth_year BETWEEN 1900 AND 2100),

  CONSTRAINT ck_ben_initial_weight
    CHECK (initial_weight_kg > 0),

  CONSTRAINT ck_ben_initial_height
    CHECK (initial_height_cm > 0)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Mnemonic alias, used while name is NULL. Unique within a program.
CREATE TABLE beneficiary_alias (
  program_id        CHAR(36)    NOT NULL,
  beneficiary_code  CHAR(5)     NOT NULL,
  alias             VARCHAR(60) NOT NULL,

  PRIMARY KEY (program_id, beneficiary_code),

  UNIQUE KEY uq_alias_per_program (program_id, alias),

  CONSTRAINT fk_alias_ben
    FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE allergy (
  allergy_id  CHAR(36)    NOT NULL,
  name        VARCHAR(80) NOT NULL,

  PRIMARY KEY (allergy_id),

  UNIQUE KEY uq_allergy_name (name)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE beneficiary_allergy (
  program_id        CHAR(36) NOT NULL,
  beneficiary_code  CHAR(5)  NOT NULL,
  allergy_id        CHAR(36) NOT NULL,

  PRIMARY KEY (program_id, beneficiary_code, allergy_id),

  KEY idx_ba_allergy (allergy_id),

  CONSTRAINT fk_ba_ben
    FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),

  CONSTRAINT fk_ba_allergy
    FOREIGN KEY (allergy_id)
    REFERENCES allergy (allergy_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE guardian (
  guardian_id  CHAR(36)     NOT NULL,
  name         VARCHAR(150) NOT NULL,
  `number`     VARCHAR(30)  NOT NULL,

  PRIMARY KEY (guardian_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Consent record:
--   * For a minor, guardian_id and relationship identify the consenting guardian.
--   * For an adult, guardian_id and relationship may be NULL.
--   * Store consent before updating beneficiary.name.
--   * On withdrawal, clear the stored name and restore/use the alias.
CREATE TABLE consent (
  program_id        CHAR(36)    NOT NULL,
  beneficiary_code  CHAR(5)     NOT NULL,
  guardian_id       CHAR(36)    NULL,
  relationship      VARCHAR(40) NULL,
  consented_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (program_id, beneficiary_code),

  KEY idx_consent_guardian (guardian_id),

  CONSTRAINT fk_consent_ben
    FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),

  CONSTRAINT fk_consent_guardian
    FOREIGN KEY (guardian_id)
    REFERENCES guardian (guardian_id),

  CONSTRAINT ck_consent_guardian_relationship
    CHECK (
      (guardian_id IS NULL AND relationship IS NULL)
      OR
      (guardian_id IS NOT NULL AND relationship IS NOT NULL)
    )

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- SESSION INPUTS
-- BMI, WHtR and WHO z-scores are computed by the application/query layer.
-- ============================================================================

-- One row per registered beneficiary per session. Present rows are written
-- during entry (re-entering the same beneficiary in the same session updates
-- this row). FALSE rows are inserted during submission reconciliation.
CREATE TABLE session_record (
  session_id        CHAR(36) NOT NULL,
  program_id        CHAR(36) NOT NULL,
  beneficiary_code  CHAR(5)  NOT NULL,
  is_present        BOOLEAN  NOT NULL DEFAULT FALSE,
  weight_kg         DECIMAL(5,1) NULL,
  height_cm         DECIMAL(5,1) NULL,
  waist_cm          DECIMAL(5,1) NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code),

  KEY idx_sr_session_presence (session_id, is_present, beneficiary_code),
  KEY idx_sr_beneficiary_history (program_id, beneficiary_code, session_id),
  KEY idx_sr_program_session (program_id, session_id, beneficiary_code),

  CONSTRAINT fk_sr_session
    FOREIGN KEY (session_id, program_id)
    REFERENCES program_session (session_id, program_id),

  CONSTRAINT fk_sr_ben
    FOREIGN KEY (program_id, beneficiary_code)
    REFERENCES beneficiary (program_id, beneficiary_code),

  CONSTRAINT ck_sr_weight
    CHECK (weight_kg IS NULL OR weight_kg > 0),

  CONSTRAINT ck_sr_height
    CHECK (height_cm IS NULL OR height_cm > 0),

  CONSTRAINT ck_sr_waist
    CHECK (waist_cm IS NULL OR waist_cm > 0)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE survey_question (
  question_id   VARCHAR(40) NOT NULL,
  prompt_minor  TEXT        NOT NULL,
  prompt_adult  TEXT        NOT NULL,

  PRIMARY KEY (question_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Survey answers are beneficiary/session-level and optional.
-- Weekly averages should be weighted by response count.
CREATE TABLE survey_answer (
  session_id        CHAR(36)    NOT NULL,
  program_id        CHAR(36)    NOT NULL,
  beneficiary_code  CHAR(5)     NOT NULL,
  question_id       VARCHAR(40) NOT NULL,
  `value`           TINYINT     NOT NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code, question_id),

  KEY idx_sa_program_session_question (program_id, session_id, question_id),
  KEY idx_sa_program_question_session (program_id, question_id, session_id),

  CONSTRAINT fk_sa_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_sa_question
    FOREIGN KEY (question_id)
    REFERENCES survey_question (question_id),

  CONSTRAINT ck_sa_value
    CHECK (`value` BETWEEN 1 AND 5)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


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

  KEY idx_nr_program_session (program_id, session_id, beneficiary_code),
  KEY idx_nr_nutritionist (nutritionist_id),

  CONSTRAINT fk_nr_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_nr_nutritionist
    FOREIGN KEY (nutritionist_id)
    REFERENCES nutritionist (nutritionist_id),

  CONSTRAINT ck_nr_muac
    CHECK (muac_cm IS NULL OR muac_cm > 0)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- NUTRITIONAL STATUS DEFINITIONS
-- status_key values: baseline | monitor | monitor_closely
-- (There is no 'unavailable'. A metric with no status simply has no row.)
-- Numeric cutoffs are still open and live in code / criteria.
-- ============================================================================

CREATE TABLE status_definition (
  status_key   VARCHAR(30)  NOT NULL,
  description  VARCHAR(150) NOT NULL,
  criteria     TEXT         NULL,

  PRIMARY KEY (status_key)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- PER-METRIC STATUS HISTORY
--
-- One row = one beneficiary's status for ONE metric at ONE session. A row exists
-- only when that metric was measured in that session:
--   bmi   : weight present in session_record (height = session height, else the
--           latest earlier height, else beneficiary.initial_height_cm).
--           Always present for the registration session.
--   whtr  : waist present in session_record (+ usable height as above).
--   muac  : nutritionist_record.muac_cm IS NOT NULL.
--   edema : nutritionist_record.edema IS NOT NULL.
--
-- *_change is a signed change against the previous row of the SAME table for the
-- same beneficiary (ordered by program_session.session_date): positive = moved
-- toward healthy, negative = moved away. NULL on the first row.
--
-- Rows are written/upserted on every save of session input (draft included) and
-- deleted if the source value is cleared. Program-wide reads must go through the
-- v_latest_* views (submitted sessions only).
-- ============================================================================

CREATE TABLE beneficiary_bmi_status (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  status_key        VARCHAR(30)  NOT NULL,
  bmi_change        DECIMAL(6,3) NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code),

  KEY idx_bmis_beneficiary_history (program_id, beneficiary_code, session_id),
  KEY idx_bmis_program_status (program_id, status_key, session_id),

  CONSTRAINT fk_bmis_session_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_bmis_status
    FOREIGN KEY (status_key)
    REFERENCES status_definition (status_key)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE beneficiary_whtr_status (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  status_key        VARCHAR(30)  NOT NULL,
  whtr_change       DECIMAL(6,3) NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code),

  KEY idx_whtrs_beneficiary_history (program_id, beneficiary_code, session_id),
  KEY idx_whtrs_program_status (program_id, status_key, session_id),

  CONSTRAINT fk_whtrs_session_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES session_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_whtrs_status
    FOREIGN KEY (status_key)
    REFERENCES status_definition (status_key)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Source is nutritionist_record, so a MUAC status cannot exist without a
-- nutritionist record for that beneficiary and session.
CREATE TABLE beneficiary_muac_status (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  status_key        VARCHAR(30)  NOT NULL,
  muac_change       DECIMAL(6,3) NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code),

  KEY idx_muacs_beneficiary_history (program_id, beneficiary_code, session_id),
  KEY idx_muacs_program_status (program_id, status_key, session_id),

  CONSTRAINT fk_muacs_nutritionist_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES nutritionist_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_muacs_status
    FOREIGN KEY (status_key)
    REFERENCES status_definition (status_key)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Edema is a yes/no check, so there is no numeric change column. Edema present
-- is expected to map to monitor_closely (SAM clinical priority), absent to baseline.
CREATE TABLE beneficiary_edema_status (
  session_id        CHAR(36)     NOT NULL,
  program_id        CHAR(36)     NOT NULL,
  beneficiary_code  CHAR(5)      NOT NULL,
  status_key        VARCHAR(30)  NOT NULL,

  PRIMARY KEY (session_id, program_id, beneficiary_code),

  KEY idx_edemas_beneficiary_history (program_id, beneficiary_code, session_id),
  KEY idx_edemas_program_status (program_id, status_key, session_id),

  CONSTRAINT fk_edemas_nutritionist_record
    FOREIGN KEY (session_id, program_id, beneficiary_code)
    REFERENCES nutritionist_record (session_id, program_id, beneficiary_code),

  CONSTRAINT fk_edemas_status
    FOREIGN KEY (status_key)
    REFERENCES status_definition (status_key)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- AI INTERPRETATIONS
-- ============================================================================

-- Ghost table for future program-wide AI integration. Generation and UI are
-- intentionally inactive for now.
CREATE TABLE ai_interpretation (
  interpretation_id  CHAR(36) NOT NULL,
  program_id         CHAR(36) NOT NULL,
  category           ENUM('nutrition_trend', 'attendance_trend', 'feedback_trend', 'program_summary') NULL,
  comments           TEXT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (interpretation_id),

  KEY idx_ai_program_created (program_id, created_at),

  CONSTRAINT fk_ai_program
    FOREIGN KEY (program_id)
    REFERENCES program (program_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================================
-- LATEST-STATUS VIEWS (SUBMITTED SESSIONS ONLY)
-- One row per beneficiary per metric: the newest status by session_date.
-- Application code computes "outdated" from session_date (see invariant 8).
-- ============================================================================

CREATE VIEW v_latest_bmi_status AS
SELECT x.program_id, x.beneficiary_code, x.session_id, x.session_date,
       x.status_key, x.bmi_change AS change_value
  FROM (
    SELECT s.program_id, s.beneficiary_code, s.session_id, ps.session_date,
           s.status_key, s.bmi_change,
           ROW_NUMBER() OVER (
             PARTITION BY s.program_id, s.beneficiary_code
             ORDER BY ps.session_date DESC
           ) AS rn
      FROM beneficiary_bmi_status s
      JOIN program_session ps
        ON ps.session_id = s.session_id AND ps.program_id = s.program_id
     WHERE ps.submitted_at IS NOT NULL
  ) x
 WHERE x.rn = 1;

CREATE VIEW v_latest_whtr_status AS
SELECT x.program_id, x.beneficiary_code, x.session_id, x.session_date,
       x.status_key, x.whtr_change AS change_value
  FROM (
    SELECT s.program_id, s.beneficiary_code, s.session_id, ps.session_date,
           s.status_key, s.whtr_change,
           ROW_NUMBER() OVER (
             PARTITION BY s.program_id, s.beneficiary_code
             ORDER BY ps.session_date DESC
           ) AS rn
      FROM beneficiary_whtr_status s
      JOIN program_session ps
        ON ps.session_id = s.session_id AND ps.program_id = s.program_id
     WHERE ps.submitted_at IS NOT NULL
  ) x
 WHERE x.rn = 1;

CREATE VIEW v_latest_muac_status AS
SELECT x.program_id, x.beneficiary_code, x.session_id, x.session_date,
       x.status_key, x.muac_change AS change_value
  FROM (
    SELECT s.program_id, s.beneficiary_code, s.session_id, ps.session_date,
           s.status_key, s.muac_change,
           ROW_NUMBER() OVER (
             PARTITION BY s.program_id, s.beneficiary_code
             ORDER BY ps.session_date DESC
           ) AS rn
      FROM beneficiary_muac_status s
      JOIN program_session ps
        ON ps.session_id = s.session_id AND ps.program_id = s.program_id
     WHERE ps.submitted_at IS NOT NULL
  ) x
 WHERE x.rn = 1;

CREATE VIEW v_latest_edema_status AS
SELECT x.program_id, x.beneficiary_code, x.session_id, x.session_date,
       x.status_key, NULL AS change_value
  FROM (
    SELECT s.program_id, s.beneficiary_code, s.session_id, ps.session_date,
           s.status_key,
           ROW_NUMBER() OVER (
             PARTITION BY s.program_id, s.beneficiary_code
             ORDER BY ps.session_date DESC
           ) AS rn
      FROM beneficiary_edema_status s
      JOIN program_session ps
        ON ps.session_id = s.session_id AND ps.program_id = s.program_id
     WHERE ps.submitted_at IS NOT NULL
  ) x
 WHERE x.rn = 1;

-- All four metrics in one shape: handy for the Outdated modal (status + metric key).
CREATE VIEW v_latest_metric_status AS
SELECT program_id, beneficiary_code, 'bmi' AS metric, session_id, session_date, status_key, change_value
  FROM v_latest_bmi_status
UNION ALL
SELECT program_id, beneficiary_code, 'whtr', session_id, session_date, status_key, change_value
  FROM v_latest_whtr_status
UNION ALL
SELECT program_id, beneficiary_code, 'muac', session_id, session_date, status_key, change_value
  FROM v_latest_muac_status
UNION ALL
SELECT program_id, beneficiary_code, 'edema', session_id, session_date, status_key, change_value
  FROM v_latest_edema_status;


-- ============================================================================
-- OPERATIONAL INVARIANTS — APPLICATION / SERVICE LAYER
-- ============================================================================
--
-- 1. PROGRAM WEEK GENERATION
--    When a program is created: insert the program, then CALL
--    generate_program_weeks(program_id) before allowing session creation.
--    Week 1 = start_date .. that week's Saturday; week 2+ = Sunday..Saturday;
--    the last week is capped at end_date. If program dates are edited later,
--    delete weeks that have no sessions and generate/append the missing ones.
--
-- 2. SESSION-WEEK VALIDATION
--    Choose the program_week whose range contains session_date and store its
--    week_id. The triggers reject a session_date outside the selected week.
--    Also validate session_date is within the program's start/end dates.
--
-- 3. REGISTRATION
--    Require initial_weight_kg and initial_height_cm. In one transaction:
--    insert beneficiary; insert the registration session_record with
--    is_present = TRUE and the same weight/height; insert the BMI status row
--    for that session. WRITE-THROUGH: while the registration session is a draft,
--    if session input for the beneficiary's registered_session_id changes
--    weight or height, also update beneficiary.initial_weight_kg / initial_height_cm.
--
-- 4. RE-ENTRY WITHIN A SESSION
--    There is one session_record per (session, beneficiary). Entering the same
--    beneficiary again in the same session UPDATES that row (and the related
--    nutritionist_record, survey answers and status rows); it never inserts a
--    second row. At submission, reconcile absent rows (is_present = FALSE) for
--    beneficiaries registered on or before that session's date. Submit sessions
--    in chronological order.
--
-- 5. STATUS ROWS (PER METRIC)
--    On every save of a beneficiary's session input, for each metric: if the
--    source value exists, upsert that metric's row (status from cutoffs, change
--    vs the previous row of the same table by session_date); if the source was
--    cleared, delete the row. After any upsert/delete, recompute the change on
--    the NEXT row of that beneficiary and metric, if one exists.
--    Height used for BMI/WHtR: session height_cm if present, else the latest
--    non-NULL height_cm ON OR BEFORE this session's date, else initial_height_cm.
--
-- 6. WEEKLY ATTENDANCE DENOMINATOR
--    Count only submitted sessions on/after each beneficiary's registration
--    date. A 0/4 attendee is represented by four reconciled FALSE rows. A
--    beneficiary registered mid-week has a smaller eligible denominator.
--
-- 7. WEEKLY MEASUREMENT COMPLETENESS
--    Count distinct present beneficiaries with any measured field (the
--    registration measurements count). Separately count missing weight, waist,
--    MUAC and edema inputs. A submitted session with zero measurements is found
--    by a grouped count over session_record plus nutritionist_record.
--
-- 8. COMPUTED IN CODE (NOT STORED)
--    * Outdated (per metric): DATEDIFF(CURRENT_DATE, session_date) > 14 on the
--      beneficiary's latest row for that metric (v_latest_*). Measured against
--      the actual current day, not against a session.
--    * No status for a metric: the beneficiary has no row in v_latest_<metric>.
--    * Last measured X sessions ago: count submitted sessions after the date of
--      the beneficiary's newest status row (any metric) through the latest
--      submitted session. Never calendar days; never draft/upcoming sessions.
--    * Height notice: shown only for young children whose height in use is old.
--
-- 9. PRIVACY
--    Insert consent before writing a real beneficiary name. When consent is
--    absent/withdrawn, keep name NULL and use beneficiary_alias.
--
-- 10. AI INTERPRETATION
--    ai_interpretation is a program-wide ghost table. Do not generate rows or
--    render AI UI until future integration is enabled.
--
-- MySQL/MariaDB CHECK constraints cannot enforce cross-table rules such as
-- consent-before-name or registration-date-before-session-date. Enforce those
-- transactionally in the application/service layer.
-- ============================================================================