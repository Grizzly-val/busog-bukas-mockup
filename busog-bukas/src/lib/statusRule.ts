/**
 * ============================================================================
 *  MOCK STATUS RULE: NOT CLINICAL GUIDANCE
 * ============================================================================
 * Isolated, pure (no DB, no I/O) calculation module for beneficiary status and
 * Timeline-over-Timeline changes.
 *
 * Canonical "Highest Severity Wins" Status Pipeline (BMI + WHtR + MUAC + Edema):
 *   1. Edema (Immediate Critical Override):
 *      - edema === true → monitor_closely ("Bilateral pitting edema present (SAM clinical priority)")
 *   2. Age-bracketed MUAC Check (Acute Wasting Tiers):
 *      - Under 5 yrs (< 60m):      < 11.5 cm → monitor_closely, 11.5–12.4 cm → monitor
 *      - Children 5–9 yrs (60–119m): < 13.5 cm → monitor_closely, 13.5–14.4 cm → monitor
 *      - Adolescents 10–17y (120–215m): < 16.0 cm → monitor_closely, 16.0–18.4 cm → monitor
 *      - Adults (>= 216m):         < 21.0 cm → monitor_closely, 21.0–22.9 cm → monitor
 *   3. BMI / BMI-for-Age Z-Score Check:
 *      - Children (< 216m): |BMI-for-age z| >= 1.5 → monitor, >= 2.5 → monitor_closely
 *      - Adults (>= 216m):  BMI < 18.5 or >= 27.5 → monitor, BMI < 16.0 or >= 35.0 → monitor_closely
 *   4. WHtR Modifier:
 *      - WHtR > 0.56 → at least monitor ("Elevated central adiposity (WHtR {whtr} > 0.56)")
 *   5. Session Attribution:
 *      - A session counts toward the Timeline it closes (the first Timeline also
 *        owns its starting session).
 *
 * BMI, WHtR and z-scores are computed here, never stored (see schema comments).
 * The z-score is a rough approximation from an interpolated median/SD table, NOT
 * the WHO LMS method. Swap `approxBmiForAgeZ` out when real reference data is chosen.
 * ============================================================================
 */

/** Matches `status_definition.status_key`. */
export type StatusKey = 'baseline' | 'monitor' | 'monitor_closely' | 'unavailable';

/** Matches `status_reason_definition.reason_key`. */
export type ReasonKey = 'normal' | 'edema' | 'muac' | 'bmi' | 'whtr' | 'incomplete_data';

export type Sex = 'female' | 'male';

export const ADULT_AGE_YEARS = 18;
export const ADULT_AGE_MONTHS = ADULT_AGE_YEARS * 12; // 216

export const MOCK_THRESHOLDS = {
  child: { monitorZ: 1.5, closelyZ: 2.5 },
  adult: { monitorLow: 18.5, monitorHigh: 27.5, closelyLow: 16, closelyHigh: 35, idealBmi: 22.0 },
  muac: {
    u5: { closely: 11.5, monitor: 12.5 },
    child5to9: { closely: 13.5, monitor: 14.5 },
    adolescent10to17: { closely: 16.0, monitor: 18.5 },
    adult: { closely: 21.0, monitor: 23.0 },
  },
  whtrBump: 0.56,
  idealWhtr: 0.47,
} as const;

/** Severity order, used to compare statuses and sort lists. */
export const STATUS_SEVERITY: Record<StatusKey, number> = {
  unavailable: -1,
  baseline: 0,
  monitor: 1,
  monitor_closely: 2,
};

/** Brief lookup descriptions matching `status_reason_definition`. */
export const REASON_DESCRIPTION: Record<ReasonKey, string> = {
  normal: 'Within healthy anthropometric and clinical thresholds',
  edema: 'Bilateral pitting edema present (SAM clinical priority)',
  muac: 'Acute wasting indicated by Mid-Upper Arm Circumference (MUAC)',
  bmi: 'BMI or BMI-for-age z-score outside healthy threshold',
  whtr: 'Elevated central adiposity indicated by Waist-to-Height Ratio (WHtR > 0.56)',
  incomplete_data: 'Incomplete anthropometric measurement (missing paired height or weight)',
};

// ---------------------------------------------------------------------------
// Basic measurements
// ---------------------------------------------------------------------------

const round = (n: number, dp = 3) => Math.round(n * 10 ** dp) / 10 ** dp;

/** BMI = kg / m². Null when either input is missing or not positive. */
export function computeBmi(weightKg: number | null, heightCm: number | null): number | null {
  if (weightKg == null || heightCm == null || weightKg <= 0 || heightCm <= 0) return null;
  const m = heightCm / 100;
  return round(weightKg / (m * m));
}

/** Waist-to-height ratio. Null when either input is missing or not positive. */
export function computeWhtr(waistCm: number | null, heightCm: number | null): number | null {
  if (waistCm == null || heightCm == null || waistCm <= 0 || heightCm <= 0) return null;
  return round(waistCm / heightCm);
}

/**
 * Age in whole months at `asOf` ('YYYY-MM-DD'), using `beneficiary.birth_month`
 * and `birth_year` (there's no birth day, so the 1st of the month is assumed).
 */
export function ageInMonths(birthMonth: number, birthYear: number, asOf: string): number {
  const [y, m] = asOf.slice(0, 10).split('-').map(Number);
  return Math.max(0, (y - birthYear) * 12 + (m - birthMonth));
}

export function isAdultAt(birthMonth: number, birthYear: number, asOf: string): boolean {
  return ageInMonths(birthMonth, birthYear, asOf) >= ADULT_AGE_MONTHS;
}

// ---------------------------------------------------------------------------
// MOCK BMI-for-age z-score (children)
// ---------------------------------------------------------------------------

/** Approximate BMI-for-age medians at whole years 1..18 (index 0 = age 1). */
const MOCK_BMI_MEDIAN: Record<Sex, number[]> = {
  male: [17.2, 16.0, 15.6, 15.3, 15.2, 15.3, 15.5, 15.7, 16.0, 16.4, 16.9, 17.5, 18.2, 19.0, 19.8, 20.5, 21.1, 21.7],
  female: [16.6, 15.7, 15.4, 15.2, 15.2, 15.3, 15.4, 15.7, 16.1, 16.6, 17.2, 18.0, 18.8, 19.6, 20.2, 20.7, 21.0, 21.3],
};

/**
 * MOCK approximation of the BMI-for-age z-score. Linearly interpolates a median
 * table and uses an SD that widens with age. Good enough to spread the mock data
 * across statuses; NOT a WHO-conformant z-score.
 */
export function approxBmiForAgeZ(bmi: number | null, ageMonths: number, sex: Sex): number | null {
  if (bmi == null) return null;
  const table = MOCK_BMI_MEDIAN[sex];
  const years = Math.min(Math.max(ageMonths / 12, 1), 18);
  const lo = Math.floor(years);
  const hi = Math.min(lo + 1, 18);
  const t = years - lo;
  const median = table[lo - 1] + (table[hi - 1] - table[lo - 1]) * t;
  const sd = median * (0.08 + 0.003 * years);
  return round((bmi - median) / sd, 2);
}

// ---------------------------------------------------------------------------
// Status classification ("Highest Severity Wins")
// ---------------------------------------------------------------------------

export type StatusInput = {
  sex: Sex;
  birthMonth: number;
  birthYear: number;
  /** Date the status is evaluated at, usually the Timeline's ending session date. */
  asOf: string;
  bmi: number | null;
  whtr: number | null;
  muacCm?: number | null;
  edema?: boolean | null;
  /** True if the beneficiary had at least one partial measurement (e.g., weight without height). */
  hasPartialMeasurement?: boolean;
};

export type StatusResult = {
  statusKey: StatusKey;
  isAdult: boolean;
  bmiZ: number | null;
  /** Brief key stored in `beneficiary_timeline_status.status_reason` (FK to `status_reason_definition`). */
  reasonKey: ReasonKey;
  /** Human-readable description corresponding to `reasonKey`. */
  reason: string;
};

/**
 * Classifies one beneficiary for one Timeline using the Canonical "Highest Severity Wins" rule.
 * - Returns `null` when the beneficiary has NO measurements at all in the Timeline.
 * - Returns `{ statusKey: 'unavailable', reasonKey: 'incomplete_data', ... }` when only partial
 *   measurements exist (e.g., weight without height, and no MUAC/edema).
 * - Otherwise evaluates Edema -> MUAC -> BMI/BMI-for-age z -> WHtR and selects the highest
 *   severity status along with the brief `reasonKey` that ultimately justifies it.
 */
export function classifyStatus(input: StatusInput): StatusResult | null {
  const {
    sex,
    birthMonth,
    birthYear,
    asOf,
    bmi,
    whtr,
    muacCm = null,
    edema = null,
    hasPartialMeasurement = false,
  } = input;

  const ageMonths = ageInMonths(birthMonth, birthYear, asOf);
  const isAdult = ageMonths >= ADULT_AGE_MONTHS;

  const hasComputableStatus = bmi != null || whtr != null || muacCm != null || edema === true;
  if (!hasComputableStatus) {
    if (hasPartialMeasurement) {
      return {
        statusKey: 'unavailable',
        isAdult,
        bmiZ: null,
        reasonKey: 'incomplete_data',
        reason: REASON_DESCRIPTION.incomplete_data,
      };
    }
    return null;
  }

  let statusKey: StatusKey = 'baseline';
  let reasonKey: ReasonKey = 'normal';
  let bmiZ: number | null = null;

  const escalate = (targetStatus: StatusKey, targetReason: ReasonKey) => {
    if (STATUS_SEVERITY[targetStatus] > STATUS_SEVERITY[statusKey]) {
      statusKey = targetStatus;
      reasonKey = targetReason;
    }
  };

  // 1. Edema Check (Immediate Critical Override)
  if (edema === true) {
    escalate('monitor_closely', 'edema');
  }

  // 2. MUAC Check (Acute Wasting Tiers, when muac_cm is non-null)
  if (muacCm != null) {
    if (ageMonths < 60) {
      if (muacCm < 11.5) {
        escalate('monitor_closely', 'muac');
      } else if (muacCm < 12.5) {
        escalate('monitor', 'muac');
      }
    } else if (ageMonths < 120) {
      if (muacCm < 13.5) {
        escalate('monitor_closely', 'muac');
      } else if (muacCm < 14.5) {
        escalate('monitor', 'muac');
      }
    } else if (ageMonths < 216) {
      if (muacCm < 16.0) {
        escalate('monitor_closely', 'muac');
      } else if (muacCm < 18.5) {
        escalate('monitor', 'muac');
      }
    } else {
      if (muacCm < 21.0) {
        escalate('monitor_closely', 'muac');
      } else if (muacCm < 23.0) {
        escalate('monitor', 'muac');
      }
    }
  }

  // 3. BMI / BMI-for-Age Z-Score Check
  if (bmi != null) {
    if (!isAdult) {
      bmiZ = approxBmiForAgeZ(bmi, ageMonths, sex);
      if (bmiZ != null) {
        if (bmiZ <= -2.5 || bmiZ >= 2.5) {
          escalate('monitor_closely', 'bmi');
        } else if (bmiZ <= -1.5 || bmiZ >= 1.5) {
          escalate('monitor', 'bmi');
        }
      }
    } else {
      if (bmi < 16.0 || bmi >= 35.0) {
        escalate('monitor_closely', 'bmi');
      } else if (bmi < 18.5 || bmi >= 27.5) {
        escalate('monitor', 'bmi');
      }
    }
  }

  // 4. WHtR Modifier
  if (whtr != null && whtr > MOCK_THRESHOLDS.whtrBump) {
    escalate('monitor', 'whtr');
  }

  return {
    statusKey,
    isAdult,
    bmiZ,
    reasonKey,
    reason: REASON_DESCRIPTION[reasonKey],
  };
}

// ---------------------------------------------------------------------------
// Timeline aggregation and change calculation
// ---------------------------------------------------------------------------

/** One session's Default + Nutritionist input for a beneficiary (subset of session_record / nutritionist_record). */
export type SessionMeasurement = {
  session_date: string; // 'YYYY-MM-DD'
  is_present: boolean | number;
  weight_kg: number | null;
  height_cm: number | null;
  waist_cm: number | null;
  muac_cm?: number | null;
  edema?: boolean | number | null;
};

export type TimelineMetrics = {
  weightKg: number | null;
  heightCm: number | null;
  waistCm: number | null;
  muacCm: number | null;
  edema: boolean | null;
  bmi: number | null;
  whtr: number | null;
};

/**
 * Collapses the sessions that belong to one Timeline into a single set of metrics.
 * Duplicate measurements inside a Timeline are resolved by taking the latest
 * non-null value of each field (weight-only and height-only rows combine).
 * Edema is true if ANY nutritionist_record in the Timeline has edema = true/1;
 * false if checked and all are false/0; null if never checked.
 * Absent rows (is_present = false) are ignored.
 */
export function summarizeTimeline(sessions: SessionMeasurement[]): TimelineMetrics {
  const present = sessions
    .filter((s) => Boolean(s.is_present))
    .sort((a, b) => a.session_date.localeCompare(b.session_date));

  const latest = <K extends keyof SessionMeasurement>(key: K) => {
    for (let i = present.length - 1; i >= 0; i--) {
      const v = present[i][key];
      if (v != null) return v as number;
    }
    return null;
  };

  const weightKg = latest('weight_kg');
  const heightCm = latest('height_cm');
  const waistCm = latest('waist_cm');
  const muacCm = latest('muac_cm');

  const edemaChecks = present
    .map((s) => s.edema)
    .filter((v): v is boolean | number => v != null);

  let edema: boolean | null = null;
  if (edemaChecks.length > 0) {
    edema = edemaChecks.some((v) => Boolean(v));
  }

  return {
    weightKg,
    heightCm,
    waistCm,
    muacCm,
    edema,
    bmi: computeBmi(weightKg, heightCm),
    whtr: computeWhtr(waistCm, heightCm),
  };
}

export type TimelineChangeContext = {
  sex: Sex;
  birthMonth: number;
  birthYear: number;
  currEndDate: string;
  prevEndDate: string;
};

/**
 * Computes optimality changes between two measurement sets:
 *   - bmi_optimality = |prev_score - ideal| - |curr_score - ideal| (ideal = 0 for child z, 22.0 for adult bmi)
 *     Positive values indicate movement closer to the optimal value; negative values indicate movement farther away.
 *   - whtr_optimality = |prev_whtr - 0.47| - |curr_whtr - 0.47|
 *     Positive values indicate movement closer to the 0.47 optimal value; negative values indicate movement farther away.
 */
export function computeTimelineChanges(
  current: TimelineMetrics,
  previous: TimelineMetrics | null,
  context?: TimelineChangeContext
) {
  if (!previous) {
    return {
      bmi_optimality: null as number | null,
      whtr_optimality: null as number | null,
      bmi_change: null as number | null,
      whtr_change: null as number | null,
      muac_change: null as number | null,
    };
  }

  let bmi_optimality: number | null = null;
  let bmi_change: number | null = null;

  if (current.bmi != null && previous.bmi != null) {
    bmi_change = round(current.bmi - previous.bmi, 3);
    if (context) {
      const currAgeMonths = ageInMonths(context.birthMonth, context.birthYear, context.currEndDate);
      const prevAgeMonths = ageInMonths(context.birthMonth, context.birthYear, context.prevEndDate);
      const isAdult = currAgeMonths >= ADULT_AGE_MONTHS;
      if (isAdult) {
        const ideal = MOCK_THRESHOLDS.adult.idealBmi;
        bmi_optimality = round(Math.abs(previous.bmi - ideal) - Math.abs(current.bmi - ideal), 3);
      } else {
        const prevZ = approxBmiForAgeZ(previous.bmi, prevAgeMonths, context.sex);
        const currZ = approxBmiForAgeZ(current.bmi, currAgeMonths, context.sex);
        if (prevZ != null && currZ != null) {
          bmi_optimality = round(Math.abs(prevZ) - Math.abs(currZ), 3);
        }
      }
    } else {
      const ideal = MOCK_THRESHOLDS.adult.idealBmi;
      bmi_optimality = round(Math.abs(previous.bmi - ideal) - Math.abs(current.bmi - ideal), 3);
    }
  }

  let whtr_optimality: number | null = null;
  let whtr_change: number | null = null;
  if (current.whtr != null && previous.whtr != null) {
    whtr_change = round(current.whtr - previous.whtr, 3);
    const idealWhtr = MOCK_THRESHOLDS.idealWhtr;
    whtr_optimality = round(Math.abs(previous.whtr - idealWhtr) - Math.abs(current.whtr - idealWhtr), 3);
  }

  const muac_change =
    current.muacCm != null && previous.muacCm != null
      ? round(current.muacCm - previous.muacCm, 3)
      : null;

  return {
    bmi_optimality,
    whtr_optimality,
    bmi_change,
    whtr_change,
    muac_change,
  };
}

export function hasTimelineMeasurement(metrics: TimelineMetrics): boolean {
  return (
    metrics.weightKg != null ||
    metrics.heightCm != null ||
    metrics.waistCm != null ||
    metrics.muacCm != null ||
    metrics.edema != null
  );
}

// ---------------------------------------------------------------------------
// Status Transition Matrix (T_{seq-1} -> T_{seq}) & Concern Key Distribution
// ---------------------------------------------------------------------------

export type StatusTransitionCategory = 'improved' | 'declined' | 'coverage_shift' | 'unchanged';

export type StatusTransitionRow = {
  fromStatus: StatusKey;
  toStatus: StatusKey;
  category: StatusTransitionCategory;
  count: number;
  pctOfCohort: number;
};

export type StatusTransitionSummary = {
  cohortTotal: number;
  improvedTotal: number;
  declinedTotal: number;
  coverageShiftTotal: number;
  unchangedTotal: number;
  rows: StatusTransitionRow[];
};

const CATEGORY_ORDER: Record<StatusTransitionCategory, number> = {
  improved: 0,
  declined: 1,
  coverage_shift: 2,
  unchanged: 3,
};

export function classifyStatusTransition(fromStatus: StatusKey, toStatus: StatusKey): StatusTransitionCategory {
  if (fromStatus === toStatus) return 'unchanged';
  if (fromStatus === 'unavailable' || toStatus === 'unavailable') return 'coverage_shift';
  if (STATUS_SEVERITY[toStatus] < STATUS_SEVERITY[fromStatus]) return 'improved';
  return 'declined';
}

export function computeStatusTransitions(
  eligibleBeneficiaryCodes: string[],
  prevStatusByCode: ReadonlyMap<string, StatusKey>,
  currStatusByCode: ReadonlyMap<string, StatusKey>
): StatusTransitionSummary {
  const cohortTotal = eligibleBeneficiaryCodes.length;
  const pairCounts = new Map<string, { fromStatus: StatusKey; toStatus: StatusKey; count: number }>();

  let improvedTotal = 0;
  let declinedTotal = 0;
  let coverageShiftTotal = 0;
  let unchangedTotal = 0;

  for (const code of eligibleBeneficiaryCodes) {
    const fromStatus: StatusKey = prevStatusByCode.get(code) ?? 'unavailable';
    const toStatus: StatusKey = currStatusByCode.get(code) ?? 'unavailable';
    const category = classifyStatusTransition(fromStatus, toStatus);

    if (category === 'improved') improvedTotal++;
    else if (category === 'declined') declinedTotal++;
    else if (category === 'coverage_shift') coverageShiftTotal++;
    else unchangedTotal++;

    const key = `${fromStatus}__${toStatus}`;
    const existing = pairCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      pairCounts.set(key, { fromStatus, toStatus, count: 1 });
    }
  }

  const rows: StatusTransitionRow[] = Array.from(pairCounts.values())
    .filter((item) => item.count > 0)
    .map((item) => {
      const category = classifyStatusTransition(item.fromStatus, item.toStatus);
      return {
        fromStatus: item.fromStatus,
        toStatus: item.toStatus,
        category,
        count: item.count,
        pctOfCohort: cohortTotal > 0 ? Math.round((item.count / cohortTotal) * 100) : 0,
      };
    })
    .sort((a, b) => {
      const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (catDiff !== 0) return catDiff;
      return b.count - a.count;
    });

  return {
    cohortTotal,
    improvedTotal,
    declinedTotal,
    coverageShiftTotal,
    unchangedTotal,
    rows,
  };
}

export type ClinicalConcernKey = Exclude<ReasonKey, 'normal' | 'incomplete_data'>;

export type ConcernKeyDistributionItem = {
  reasonKey: ClinicalConcernKey;
  title: string;
  description: string;
  monitorCount: number;
  closelyCount: number;
  totalFlagged: number;
  pctOfFlagged: number;
  pctOfMeasured: number;
};

export type ConcernKeyDistributionSummary = {
  registeredCount: number;
  measuredCount: number;
  totalFlaggedCount: number;
  normalCount: number;
  normalPctOfMeasured: number;
  incompleteMeasuredCount: number;
  unmeasuredCount: number;
  totalUnavailableOrUnmeasured: number;
  items: ConcernKeyDistributionItem[];
};

export const CLINICAL_CONCERN_META: Array<{
  reasonKey: ClinicalConcernKey;
  title: string;
  description: string;
}> = [
  {
    reasonKey: 'bmi',
    title: 'BMI / Z-Score Deviation',
    description: REASON_DESCRIPTION.bmi,
  },
  {
    reasonKey: 'muac',
    title: 'Acute Wasting (MUAC)',
    description: REASON_DESCRIPTION.muac,
  },
  {
    reasonKey: 'whtr',
    title: 'Central Adiposity (WHtR)',
    description: REASON_DESCRIPTION.whtr,
  },
  {
    reasonKey: 'edema',
    title: 'Nutritional Edema',
    description: REASON_DESCRIPTION.edema,
  },
];

export function computeConcernKeyDistribution(
  statusRows: Array<{ beneficiary_code: string; status_key: StatusKey; status_reason: ReasonKey }>,
  registeredCount: number,
  measuredCount: number
): ConcernKeyDistributionSummary {
  const countsByKey = new Map<ClinicalConcernKey, { monitorCount: number; closelyCount: number }>();
  for (const meta of CLINICAL_CONCERN_META) {
    countsByKey.set(meta.reasonKey, { monitorCount: 0, closelyCount: 0 });
  }

  let normalCount = 0;
  let incompleteMeasuredCount = 0;

  for (const row of statusRows) {
    if (row.status_key === 'baseline' || row.status_reason === 'normal') {
      normalCount++;
    } else if (row.status_key === 'unavailable' || row.status_reason === 'incomplete_data') {
      incompleteMeasuredCount++;
    } else {
      const bucket = countsByKey.get(row.status_reason as ClinicalConcernKey);
      if (bucket) {
        if (row.status_key === 'monitor') bucket.monitorCount++;
        else if (row.status_key === 'monitor_closely') bucket.closelyCount++;
      }
    }
  }

  let totalFlaggedCount = 0;
  for (const bucket of countsByKey.values()) {
    totalFlaggedCount += bucket.monitorCount + bucket.closelyCount;
  }

  const effectiveMeasured = Math.max(measuredCount, statusRows.length);
  const unmeasuredCount = Math.max(0, registeredCount - statusRows.length);

  const items: ConcernKeyDistributionItem[] = CLINICAL_CONCERN_META.map((meta) => {
    const bucket = countsByKey.get(meta.reasonKey) ?? { monitorCount: 0, closelyCount: 0 };
    const totalForKey = bucket.monitorCount + bucket.closelyCount;
    return {
      reasonKey: meta.reasonKey,
      title: meta.title,
      description: meta.description,
      monitorCount: bucket.monitorCount,
      closelyCount: bucket.closelyCount,
      totalFlagged: totalForKey,
      pctOfFlagged: totalFlaggedCount > 0 ? Math.round((totalForKey / totalFlaggedCount) * 100) : 0,
      pctOfMeasured: effectiveMeasured > 0 ? Math.round((totalForKey / effectiveMeasured) * 100) : 0,
    };
  }).sort((a, b) => b.totalFlagged - a.totalFlagged);

  return {
    registeredCount,
    measuredCount: effectiveMeasured,
    totalFlaggedCount,
    normalCount,
    normalPctOfMeasured: effectiveMeasured > 0 ? Math.round((normalCount / effectiveMeasured) * 100) : 0,
    incompleteMeasuredCount,
    unmeasuredCount,
    totalUnavailableOrUnmeasured: incompleteMeasuredCount + unmeasuredCount,
    items,
  };
}

// ---------------------------------------------------------------------------
// Display helpers (Bootstrap)
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<StatusKey, string> = {
  baseline: 'Baseline',
  monitor: 'Monitor',
  monitor_closely: 'Monitor closely',
  unavailable: 'Unavailable',
};

export const STATUS_BADGE_CLASS: Record<StatusKey, string> = {
  baseline: 'badge-pale-success',
  monitor: 'badge-pale-warning',
  monitor_closely: 'badge-pale-danger',
  unavailable: 'badge-pale-neutral text-muted',
};

export const REASON_LABEL: Record<ReasonKey, string> = {
  normal: 'normal',
  edema: 'edema',
  muac: 'muac',
  bmi: 'bmi',
  whtr: 'whtr',
  incomplete_data: 'incomplete_data',
};
