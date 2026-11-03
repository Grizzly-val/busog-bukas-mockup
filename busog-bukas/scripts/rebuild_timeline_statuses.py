#!/usr/bin/env python3
"""
Migrate `status_reason_definition` Lookup Table, Add `unavailable` Status,
and Rebuild `beneficiary_timeline_status`.

Changes applied:
1. Creates `status_reason_definition (reason_key, description)` lookup table and seeds
   brief reason keys:
   - 'normal'          : Within healthy anthropometric and clinical thresholds
   - 'edema'           : Bilateral pitting edema present (SAM clinical priority)
   - 'muac'            : Acute wasting indicated by Mid-Upper Arm Circumference (MUAC)
   - 'bmi'             : BMI or BMI-for-age z-score outside healthy threshold
   - 'whtr'            : Elevated central adiposity indicated by Waist-to-Height Ratio (WHtR > 0.56)
   - 'incomplete_data' : Incomplete anthropometric measurement (missing paired height or weight)
2. Adds `'unavailable'` to `status_definition` for partially measured beneficiaries.
3. Alters `beneficiary_timeline_status.status_reason` to `VARCHAR(30) NOT NULL DEFAULT 'normal'`
   and adds foreign key `fk_bts_reason` referencing `status_reason_definition(reason_key)`.
4. Rebuilds all `beneficiary_timeline_status` rows across all closed Timelines using the
   Canonical "Highest Severity Wins" rule and prints a verification report.
"""

import os
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple
import pymysql
import pymysql.cursors

# ---------------------------------------------------------------------------
# Constants & Reference Tables
# ---------------------------------------------------------------------------

ADULT_AGE_MONTHS = 216  # 18 years * 12 months
IDEAL_ADULT_BMI = 22.0
IDEAL_WHTR = 0.47
WHTR_BUMP = 0.56

STATUS_SEVERITY: Dict[str, int] = {
    "unavailable": -1,
    "baseline": 0,
    "monitor": 1,
    "monitor_closely": 2,
}

MOCK_BMI_MEDIAN: Dict[str, List[float]] = {
    "male": [
        17.2, 16.0, 15.6, 15.3, 15.2, 15.3, 15.5, 15.7, 16.0,
        16.4, 16.9, 17.5, 18.2, 19.0, 19.8, 20.5, 21.1, 21.7,
    ],
    "female": [
        16.6, 15.7, 15.4, 15.2, 15.2, 15.3, 15.4, 15.7, 16.1,
        16.6, 17.2, 18.0, 18.8, 19.6, 20.2, 20.7, 21.0, 21.3,
    ],
}

REASON_DEFINITIONS: List[Tuple[str, str]] = [
    ("normal", "Within healthy anthropometric and clinical thresholds"),
    ("edema", "Bilateral pitting edema present (SAM clinical priority)"),
    ("muac", "Acute wasting indicated by Mid-Upper Arm Circumference (MUAC)"),
    ("bmi", "BMI or BMI-for-age z-score outside healthy threshold"),
    ("whtr", "Elevated central adiposity indicated by Waist-to-Height Ratio (WHtR > 0.56)"),
    ("incomplete_data", "Incomplete anthropometric measurement (missing paired height or weight)"),
]

STATUS_DEFINITIONS: List[Tuple[str, str, str]] = [
    (
        "baseline",
        "Within expected range for age and sex",
        "MOCK RULE (BMI + WHtR + MUAC + Edema): Assigned when no edema is present, MUAC is within normal age-bracketed thresholds, child |BMI-for-age z| < 1.5 (or adult BMI 18.5-27.4), and WHtR <= 0.56.",
    ),
    (
        "monitor",
        "Mild-to-moderate deviation or elevated WHtR — watch trend across Timelines",
        "MOCK RULE (BMI + WHtR + MUAC + Edema): Assigned when moderate wasting by MUAC (U5: 11.5-12.4cm, 5-9y: 13.5-14.4cm, 10-17y: 16.0-18.4cm, Adult: 21.0-22.9cm), child 1.5 <= |BMI-for-age z| < 2.5, adult BMI 16.0-18.4 or 27.5-34.9, or WHtR > 0.56.",
    ),
    (
        "monitor_closely",
        "Severe deviation or clinical priority (edema / severe MUAC) — prioritize follow-up",
        "MOCK RULE (BMI + WHtR + MUAC + Edema): Highest severity override. Assigned when bilateral pitting edema is present, severe wasting by MUAC (U5: <11.5cm, 5-9y: <13.5cm, 10-17y: <16.0cm, Adult: <21.0cm), child |BMI-for-age z| >= 2.5, or adult BMI < 16.0 or >= 35.0.",
    ),
    (
        "unavailable",
        "Incomplete measurement data — status cannot be computed",
        "Assigned when a beneficiary was present and partially measured in the Timeline (e.g., weight without height, or height without weight/waist) and has no MUAC or edema check, preventing BMI/WHtR calculation.",
    ),
]


# ---------------------------------------------------------------------------
# Pure Calculation Helpers
# ---------------------------------------------------------------------------

def to_date_str(val: Any) -> str:
    if isinstance(val, (date, datetime)):
        return val.strftime("%Y-%m-%d")
    return str(val)[:10]


def compute_bmi(weight_kg: Optional[float], height_cm: Optional[float]) -> Optional[float]:
    if weight_kg is None or height_cm is None or weight_kg <= 0 or height_cm <= 0:
        return None
    m = height_cm / 100.0
    return round(weight_kg / (m * m), 3)


def compute_whtr(waist_cm: Optional[float], height_cm: Optional[float]) -> Optional[float]:
    if waist_cm is None or height_cm is None or waist_cm <= 0 or height_cm <= 0:
        return None
    return round(waist_cm / height_cm, 3)


def age_in_months(birth_month: int, birth_year: int, as_of: str) -> int:
    parts = as_of[:10].split("-")
    y, m = int(parts[0]), int(parts[1])
    return max(0, (y - birth_year) * 12 + (m - birth_month))


def approx_bmi_for_age_z(bmi: Optional[float], age_months: int, sex: str) -> Optional[float]:
    if bmi is None:
        return None
    table = MOCK_BMI_MEDIAN[sex]
    years = min(max(age_months / 12.0, 1.0), 18.0)
    lo = int(years)
    hi = min(lo + 1, 18)
    t = years - lo
    median = table[lo - 1] + (table[hi - 1] - table[lo - 1]) * t
    sd = median * (0.08 + 0.003 * years)
    return round((bmi - median) / sd, 2)


def is_session_owned_by_timeline(session_date: str, seq: int, start_date: str, end_date: str) -> bool:
    s_date = session_date[:10]
    st_date = start_date[:10]
    en_date = end_date[:10]
    if seq == 1:
        return st_date <= s_date <= en_date
    return st_date < s_date <= en_date


def summarize_timeline(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Collapses submitted sessions in a Timeline (ordered by session_date ASC) into a single
    set of metrics for one beneficiary.
    """
    present = [r for r in records if bool(r.get("is_present"))]
    present.sort(key=lambda r: to_date_str(r["session_date"]))

    def latest_val(key: str) -> Optional[float]:
        for r in reversed(present):
            val = r.get(key)
            if val is not None:
                return float(val)
        return None

    weight_kg = latest_val("weight_kg")
    height_cm = latest_val("height_cm")
    waist_cm = latest_val("waist_cm")
    muac_cm = latest_val("muac_cm")

    edema_checks = [r.get("edema") for r in present if r.get("edema") is not None]
    if len(edema_checks) == 0:
        edema: Optional[bool] = None
    else:
        edema = any(bool(v) for v in edema_checks)

    return {
        "weight_kg": weight_kg,
        "height_cm": height_cm,
        "waist_cm": waist_cm,
        "muac_cm": muac_cm,
        "edema": edema,
        "bmi": compute_bmi(weight_kg, height_cm),
        "whtr": compute_whtr(waist_cm, height_cm),
    }


def classify_status(
    sex: str,
    birth_month: int,
    birth_year: int,
    as_of: str,
    metrics: Dict[str, Any],
) -> Optional[Tuple[str, str]]:
    """
    Evaluates all four signals using "Highest Severity Wins" (`monitor_closely` > `monitor` > `baseline`),
    or assigns `('unavailable', 'incomplete_data')` when only partial measurements exist.
    Returns `(status_key, reason_key)` or `None` if no measurement was recorded at all.
    """
    weight_kg = metrics["weight_kg"]
    height_cm = metrics["height_cm"]
    waist_cm = metrics["waist_cm"]
    bmi = metrics["bmi"]
    whtr = metrics["whtr"]
    muac_cm = metrics["muac_cm"]
    edema = metrics["edema"]

    has_any_measurement = (
        weight_kg is not None
        or height_cm is not None
        or waist_cm is not None
        or muac_cm is not None
        or edema is True
    )
    if not has_any_measurement:
        return None

    has_computable_status = (
        bmi is not None
        or whtr is not None
        or muac_cm is not None
        or edema is True
    )
    if not has_computable_status:
        return ("unavailable", "incomplete_data")

    age_months = age_in_months(birth_month, birth_year, as_of)
    is_adult = age_months >= ADULT_AGE_MONTHS

    status_key = "baseline"
    reason_key = "normal"

    def escalate(target_status: str, target_reason: str) -> None:
        nonlocal status_key, reason_key
        if STATUS_SEVERITY[target_status] > STATUS_SEVERITY[status_key]:
            status_key = target_status
            reason_key = target_reason

    # 1. Edema Check (Immediate Critical Override)
    if edema is True:
        escalate("monitor_closely", "edema")

    # 2. MUAC Check (Acute Wasting Tiers)
    if muac_cm is not None:
        if age_months < 60:
            if muac_cm < 11.5:
                escalate("monitor_closely", "muac")
            elif muac_cm < 12.5:
                escalate("monitor", "muac")
        elif age_months < 120:
            if muac_cm < 13.5:
                escalate("monitor_closely", "muac")
            elif muac_cm < 14.5:
                escalate("monitor", "muac")
        elif age_months < 216:
            if muac_cm < 16.0:
                escalate("monitor_closely", "muac")
            elif muac_cm < 18.5:
                escalate("monitor", "muac")
        else:
            if muac_cm < 21.0:
                escalate("monitor_closely", "muac")
            elif muac_cm < 23.0:
                escalate("monitor", "muac")

    # 3. BMI / BMI-for-Age Z-Score Check
    if bmi is not None:
        if not is_adult:
            z = approx_bmi_for_age_z(bmi, age_months, sex)
            if z is not None:
                if z <= -2.5 or z >= 2.5:
                    escalate("monitor_closely", "bmi")
                elif z <= -1.5 or z >= 1.5:
                    escalate("monitor", "bmi")
        else:
            if bmi < 16.0 or bmi >= 35.0:
                escalate("monitor_closely", "bmi")
            elif bmi < 18.5 or bmi >= 27.5:
                escalate("monitor", "bmi")

    # 4. WHtR Modifier
    if whtr is not None and whtr > WHTR_BUMP:
        escalate("monitor", "whtr")

    return (status_key, reason_key)


def compute_changes(
    curr_metrics: Dict[str, Any],
    prev_metrics: Optional[Dict[str, Any]],
    sex: str,
    birth_month: int,
    birth_year: int,
    curr_end_date: str,
    prev_end_date: Optional[str],
) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    if prev_metrics is None or prev_end_date is None:
        return (None, None, None)

    bmi_change: Optional[float] = None
    if curr_metrics["bmi"] is not None and prev_metrics["bmi"] is not None:
        curr_age = age_in_months(birth_month, birth_year, curr_end_date)
        prev_age = age_in_months(birth_month, birth_year, prev_end_date)
        is_adult = curr_age >= ADULT_AGE_MONTHS
        if is_adult:
            bmi_change = round(
                abs(prev_metrics["bmi"] - IDEAL_ADULT_BMI) - abs(curr_metrics["bmi"] - IDEAL_ADULT_BMI),
                3,
            )
        else:
            prev_z = approx_bmi_for_age_z(prev_metrics["bmi"], prev_age, sex)
            curr_z = approx_bmi_for_age_z(curr_metrics["bmi"], curr_age, sex)
            if prev_z is not None and curr_z is not None:
                bmi_change = round(abs(prev_z) - abs(curr_z), 3)

    whtr_change: Optional[float] = None
    if curr_metrics["whtr"] is not None and prev_metrics["whtr"] is not None:
        whtr_change = round(
            abs(prev_metrics["whtr"] - IDEAL_WHTR) - abs(curr_metrics["whtr"] - IDEAL_WHTR),
            3,
        )

    muac_change: Optional[float] = None
    if curr_metrics["muac_cm"] is not None and prev_metrics["muac_cm"] is not None:
        muac_change = round(curr_metrics["muac_cm"] - prev_metrics["muac_cm"], 3)

    return (bmi_change, whtr_change, muac_change)


# ---------------------------------------------------------------------------
# Database Rebuild Pipeline
# ---------------------------------------------------------------------------

def main() -> None:
    conn = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "busog_bukas"),
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )

    try:
        with conn.cursor() as cur:
            # 1. Create status_reason_definition lookup table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS status_reason_definition (
                  reason_key   VARCHAR(30)  NOT NULL,
                  description  VARCHAR(150) NOT NULL,
                  PRIMARY KEY (reason_key)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """
            )
            for r_key, r_desc in REASON_DEFINITIONS:
                cur.execute(
                    """
                    INSERT INTO status_reason_definition (reason_key, description)
                    VALUES (%s, %s)
                    ON DUPLICATE KEY UPDATE description = VALUES(description)
                    """,
                    (r_key, r_desc),
                )
            print("[OK] Created and seeded `status_reason_definition` lookup table.")

            # 2. Upsert status_definition (including 'unavailable')
            for s_key, s_desc, s_crit in STATUS_DEFINITIONS:
                cur.execute(
                    """
                    INSERT INTO status_definition (status_key, description, criteria)
                    VALUES (%s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      description = VALUES(description),
                      criteria = VALUES(criteria)
                    """,
                    (s_key, s_desc, s_crit),
                )
            print("[OK] Updated `status_definition` (added `unavailable` status_key).")

            # 3. Clear beneficiary_timeline_status before schema migration
            cur.execute("DELETE FROM beneficiary_timeline_status")
            deleted_count = cur.rowcount
            print(f"[OK] Cleared {deleted_count} existing rows from `beneficiary_timeline_status`.")

            # 4. Ensure status_reason column is VARCHAR(30) and has FK to status_reason_definition
            cur.execute(
                """
                SELECT COLUMN_NAME
                  FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'beneficiary_timeline_status'
                   AND COLUMN_NAME = 'status_reason'
                """
            )
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE beneficiary_timeline_status
                    ADD COLUMN status_reason VARCHAR(30) NOT NULL DEFAULT 'normal' AFTER status_key
                    """
                )
            else:
                cur.execute(
                    """
                    ALTER TABLE beneficiary_timeline_status
                    MODIFY COLUMN status_reason VARCHAR(30) NOT NULL DEFAULT 'normal'
                    """
                )

            cur.execute(
                """
                SELECT CONSTRAINT_NAME
                  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'beneficiary_timeline_status'
                   AND COLUMN_NAME = 'status_reason'
                   AND REFERENCED_TABLE_NAME = 'status_reason_definition'
                """
            )
            if not cur.fetchone():
                cur.execute(
                    """
                    ALTER TABLE beneficiary_timeline_status
                    ADD CONSTRAINT fk_bts_reason
                    FOREIGN KEY (status_reason) REFERENCES status_reason_definition (reason_key)
                    """
                )
                print("[OK] Added foreign key `fk_bts_reason` -> `status_reason_definition(reason_key)`.")
            else:
                print("[OK] Foreign key `fk_bts_reason` already exists.")

            # 5. Fetch all programs across all organizations
            cur.execute(
                """
                SELECT p.program_id, p.title AS program_name, o.name AS org_name
                  FROM program p
                  JOIN organization o ON o.org_id = p.org_id
                 ORDER BY o.name ASC, p.title ASC
                """
            )
            programs = cur.fetchall()

            total_inserted = 0
            print("\n" + "=" * 95)
            print("REBUILD VERIFICATION REPORT")
            print("=" * 95)

            for prog in programs:
                program_id = prog["program_id"]
                program_name = prog["program_name"]
                org_name = prog["org_name"]

                cur.execute(
                    """
                    SELECT t.timeline_id, t.seq, t.closed_at,
                           s_start.session_date AS start_date,
                           s_end.session_date AS end_date
                      FROM timeline t
                      JOIN program_session s_start ON s_start.session_id = t.start_session_id
                      JOIN program_session s_end ON s_end.session_id = t.end_session_id
                     WHERE t.program_id = %s
                       AND t.closed_at IS NOT NULL
                     ORDER BY t.seq ASC
                    """,
                    (program_id,),
                )
                closed_timelines = cur.fetchall()

                print(f"\nProgram: {program_name} ({org_name})")
                if not closed_timelines:
                    print("  No closed timelines.")
                    continue

                cur.execute(
                    """
                    SELECT b.beneficiary_code, b.birth_month, b.birth_year, b.sex,
                           ps.session_date AS registered_session_date
                      FROM beneficiary b
                      JOIN program_session ps ON ps.session_id = b.registered_session_id
                     WHERE b.program_id = %s
                     ORDER BY b.beneficiary_code ASC
                    """,
                    (program_id,),
                )
                beneficiaries = cur.fetchall()

                cur.execute(
                    """
                    SELECT sr.session_id, sr.beneficiary_code, sr.is_present,
                           sr.weight_kg, sr.height_cm, sr.waist_cm,
                           ps.session_date,
                           nr.muac_cm, nr.edema
                      FROM session_record sr
                      JOIN program_session ps ON ps.session_id = sr.session_id
                      LEFT JOIN nutritionist_record nr
                        ON nr.session_id = sr.session_id
                       AND nr.program_id = sr.program_id
                       AND nr.beneficiary_code = sr.beneficiary_code
                     WHERE sr.program_id = %s
                       AND ps.submitted_at IS NOT NULL
                     ORDER BY ps.session_date ASC
                    """,
                    (program_id,),
                )
                submitted_records = cur.fetchall()

                metrics_by_seq: Dict[int, Dict[str, Dict[str, Any]]] = {}
                end_date_by_seq: Dict[int, str] = {}

                for tl in closed_timelines:
                    seq = int(tl["seq"])
                    tl_id = tl["timeline_id"]
                    start_date = to_date_str(tl["start_date"])
                    end_date = to_date_str(tl["end_date"])
                    end_date_by_seq[seq] = end_date

                    records_by_ben: Dict[str, List[Dict[str, Any]]] = {}
                    for r in submitted_records:
                        s_date = to_date_str(r["session_date"])
                        if is_session_owned_by_timeline(s_date, seq, start_date, end_date):
                            records_by_ben.setdefault(r["beneficiary_code"], []).append(r)

                    metrics_by_seq[seq] = {}
                    dist_status = {"baseline": 0, "monitor": 0, "monitor_closely": 0, "unavailable": 0}
                    dist_reason = {"normal": 0, "edema": 0, "muac": 0, "bmi": 0, "whtr": 0, "incomplete_data": 0}

                    for ben in beneficiaries:
                        code = ben["beneficiary_code"]
                        reg_date = to_date_str(ben["registered_session_date"])
                        if reg_date > end_date:
                            continue

                        ben_records = records_by_ben.get(code, [])
                        curr_metrics = summarize_timeline(ben_records)
                        metrics_by_seq[seq][code] = curr_metrics

                        res = classify_status(
                            sex=ben["sex"],
                            birth_month=int(ben["birth_month"]),
                            birth_year=int(ben["birth_year"]),
                            as_of=end_date,
                            metrics=curr_metrics,
                        )
                        if res is None:
                            continue

                        status_key, reason_key = res
                        dist_status[status_key] += 1
                        dist_reason[reason_key] += 1

                        prev_metrics = metrics_by_seq.get(seq - 1, {}).get(code) if seq > 1 else None
                        prev_end_date = end_date_by_seq.get(seq - 1) if seq > 1 else None

                        bmi_chg, whtr_chg, muac_chg = compute_changes(
                            curr_metrics=curr_metrics,
                            prev_metrics=prev_metrics,
                            sex=ben["sex"],
                            birth_month=int(ben["birth_month"]),
                            birth_year=int(ben["birth_year"]),
                            curr_end_date=end_date,
                            prev_end_date=prev_end_date,
                        )

                        cur.execute(
                            """
                            INSERT INTO beneficiary_timeline_status (
                              program_id, beneficiary_code, timeline_id,
                              status_key, status_reason,
                              bmi_change, whtr_change, muac_change
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                program_id,
                                code,
                                tl_id,
                                status_key,
                                reason_key,
                                bmi_chg,
                                whtr_chg,
                                muac_chg,
                            ),
                        )
                        total_inserted += 1

                    row_total = sum(dist_status.values())
                    print(
                        f"  Timeline {seq} ({start_date} -> {end_date}): "
                        f"{row_total} rows | "
                        f"baseline: {dist_status['baseline']}, "
                        f"monitor: {dist_status['monitor']}, "
                        f"monitor_closely: {dist_status['monitor_closely']}, "
                        f"unavailable: {dist_status['unavailable']}"
                    )
                    print(
                        f"    Reasons -> normal: {dist_reason['normal']}, "
                        f"bmi: {dist_reason['bmi']}, "
                        f"whtr: {dist_reason['whtr']}, "
                        f"muac: {dist_reason['muac']}, "
                        f"edema: {dist_reason['edema']}, "
                        f"incomplete_data: {dist_reason['incomplete_data']}"
                    )

            conn.commit()
            print("\n" + "=" * 95)
            print(f"SUCCESS: Committed {total_inserted} rows into `beneficiary_timeline_status`.")
            print("=" * 95)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
