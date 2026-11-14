/**
 * ============================================================================
 *  MOCK STATUS RULE: NOT CLINICAL GUIDANCE
 * ============================================================================
 * Isolated, pure (no DB, no I/O) calculation module for per-metric beneficiary
 * status (BMI, WHtR, MUAC, Edema), signed change values, carry-forward height,
 * outdated checks, height notice, and date-windowed status transitions.
 *
 * Per-Metric Cutoffs:
 *   - BMI / BMI-for-Age Z-Score:
 *       Children (< 216m): |z| >= 2.5 -> monitor_closely, >= 1.5 -> monitor, else baseline
 *       Adults (>= 216m):  BMI < 16.0 or >= 35.0 -> monitor_closely,
 *                          BMI < 18.5 or >= 27.5 -> monitor, else baseline
 *   - WHtR (Waist-to-Height Ratio):
 *       > 0.65 -> monitor_closely, > 0.56 -> monitor, else baseline
 *   - MUAC (Mid-Upper Arm Circumference):
 *       < 60m:      < 11.5 -> monitor_closely, < 12.5 -> monitor, else baseline
 *       60..119m:   < 13.5 -> monitor_closely, < 14.5 -> monitor, else baseline
 *       120..215m:  < 16.0 -> monitor_closely, < 18.5 -> monitor, else baseline
 *       >= 216m:    < 21.0 -> monitor_closely, < 23.0 -> monitor, else baseline
 *   - Edema:
 *       edema === true  -> monitor_closely
 *       edema === false -> baseline
 *
 * BMI, WHtR and z-scores are computed in code, never stored in the schema.
 * The z-score is a rough approximation from an interpolated median/SD table,
 * NOT the WHO LMS method.
 * ============================================================================
 */

import { daysBetween } from './format';

/** Matches `status_definition.status_key`. Note: 'unavailable' no longer exists. */
export type StatusKey = 'baseline' | 'monitor' | 'monitor_closely';

export type MetricKey = 'bmi' | 'whtr' | 'muac' | 'edema';

export const ALL_METRICS: readonly MetricKey[] = ['bmi', 'whtr', 'muac', 'edema'] as const;

export const METRIC_LABEL: Record<MetricKey, string> = {
  bmi: 'BMI',
  whtr: 'WHtR',
  muac: 'MUAC',
  edema: 'Edema',
};

export const METRIC_DESCRIPTION: Record<MetricKey, string> = {
  bmi: 'Body Mass Index / BMI-for-age z-score from weight and effective height',
  whtr: 'Waist-to-Height Ratio from waist circumference and effective height',
  muac: 'Mid-Upper Arm Circumference (nutritionist clinical wasting screen)',
  edema: 'Bilateral pitting edema check (nutritionist clinical screen)',
};

export type Sex = 'female' | 'male';

export const ADULT_AGE_YEARS = 18;
export const ADULT_AGE_MONTHS = ADULT_AGE_YEARS * 12; // 216

/** Outdated threshold: more than 14 days before today. */
export const OUTDATED_THRESHOLD_DAYS = 14;

/** Young child height notice: < 5 years old and height in use > 28 days old. */
export const HEIGHT_NOTICE_MAX_AGE_MONTHS = 60;
export const HEIGHT_NOTICE_MAX_AGE_DAYS = 28;
export const HEIGHT_NOTICE_MESSAGE = 'This child may be growing quickly, take a fresh height';

/** Needs measurement badge/filter threshold: >= 1 submitted session ago. */
export const NEEDS_MEASUREMENT_MIN_SESSIONS_AGO = 1;

export const MOCK_THRESHOLDS = {
  child: { monitorZ: 1.5, closelyZ: 2.5 },
  adult: { monitorLow: 18.5, monitorHigh: 27.5, closelyLow: 16, closelyHigh: 35, idealBmi: 22.0 },
  whtr: { monitor: 0.56, closely: 0.65, ideal: 0.47 },
  muac: {
    u5: { closely: 11.5, monitor: 12.5 },
    child5to9: { closely: 13.5, monitor: 14.5 },
    adolescent10to17: { closely: 16.0, monitor: 18.5 },
    adult: { closely: 21.0, monitor: 23.0 },
  },
} as const;

/** Severity order, used to compare statuses and sort lists. */
export const STATUS_SEVERITY: Record<StatusKey, number> = {
  baseline: 0,
  monitor: 1,
  monitor_closely: 2,
};

export const STATUS_LABEL: Record<StatusKey, string> = {
  baseline: 'Baseline',
  monitor: 'Monitor',
  monitor_closely: 'Monitor closely',
};

export const STATUS_BADGE_CLASS: Record<StatusKey, string> = {
  baseline: 'badge-pale-success',
  monitor: 'badge-pale-warning',
  monitor_closely: 'badge-pale-danger',
};

// ---------------------------------------------------------------------------
// Basic measurements & age helpers
// ---------------------------------------------------------------------------

export const round = (n: number, dp = 3): number => Math.round(n * 10 ** dp) / 10 ** dp;

/** Clamp change values cleanly inside DECIMAL(6,3) range (-999.999 .. 999.999). */
const clampDecimal6_3 = (n: number): number => Math.max(-999.999, Math.min(999.999, round(n, 3)));

/** BMI = kg / m². Null when either input is missing or not positive. */
export function computeBmi(weightKg: number | null, heightCm: number | null): number | null {
  if (weightKg == null || heightCm == null || weightKg <= 0 || heightCm <= 0) return null;
  const m = heightCm / 100;
  return round(weightKg / (m * m), 2);
}

/** Waist-to-height ratio. Null when either input is missing or not positive. */
export function computeWhtr(waistCm: number | null, heightCm: number | null): number | null {
  if (waistCm == null || heightCm == null || waistCm <= 0 || heightCm <= 0) return null;
  return round(waistCm / heightCm, 3);
}

/**
 * Age in whole months at `asOf` ('YYYY-MM-DD'), using `beneficiary.birth_month`
 * and `birth_year` (no birth day in schema, so the 1st of the month is assumed).
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
 * table and uses an SD that widens with age. Good enough to spread mock data
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
// Carry-forward height resolution
// ---------------------------------------------------------------------------

export type EffectiveHeightResolution = {
  heightCm: number | null;
  heightDate: string | null;
  carriedForward: boolean;
};

/**
 * Resolves the effective height for a session date:
 * 1. Explicit height recorded at the target session (if non-null & > 0),
 * 2. Else the latest earlier recorded height strictly on/before the target date,
 * 3. Else beneficiary.initial_height_cm (attributed to registration date if known).
 */
export function resolveEffectiveHeight(params: {
  sessionDate: string;
  sessionHeightCm: number | null | undefined;
  priorHeights: Array<{ sessionDate: string; heightCm: number | null | undefined }>;
  initialHeightCm: number | null | undefined;
  registrationDate?: string | null;
}): EffectiveHeightResolution {
  const targetDate = params.sessionDate.slice(0, 10);

  if (params.sessionHeightCm != null && params.sessionHeightCm > 0) {
    return {
      heightCm: params.sessionHeightCm,
      heightDate: targetDate,
      carriedForward: false,
    };
  }

  const eligiblePrior = params.priorHeights
    .filter((h) => h.heightCm != null && h.heightCm > 0 && h.sessionDate.slice(0, 10) <= targetDate)
    .sort((a, b) => b.sessionDate.slice(0, 10).localeCompare(a.sessionDate.slice(0, 10)));

  if (eligiblePrior.length > 0) {
    return {
      heightCm: eligiblePrior[0].heightCm!,
      heightDate: eligiblePrior[0].sessionDate.slice(0, 10),
      carriedForward: true,
    };
  }

  if (params.initialHeightCm != null && params.initialHeightCm > 0) {
    return {
      heightCm: params.initialHeightCm,
      heightDate: params.registrationDate ? params.registrationDate.slice(0, 10) : null,
      carriedForward: true,
    };
  }

  return { heightCm: null, heightDate: null, carriedForward: false };
}

// ---------------------------------------------------------------------------
// Per-metric status classifiers
// ---------------------------------------------------------------------------

export function classifyBmiStatus(input: {
  sex: Sex;
  birthMonth: number;
  birthYear: number;
  asOf: string;
  weightKg: number | null | undefined;
  heightCm: number | null | undefined;
}): { statusKey: StatusKey; bmi: number; bmiZ: number | null; isAdult: boolean } | null {
  if (input.weightKg == null || input.heightCm == null || input.weightKg <= 0 || input.heightCm <= 0) {
    return null;
  }
  const bmi = computeBmi(input.weightKg, input.heightCm);
  if (bmi == null) return null;

  const months = ageInMonths(input.birthMonth, input.birthYear, input.asOf);
  const isAdult = months >= ADULT_AGE_MONTHS;
  const bmiZ = isAdult ? null : approxBmiForAgeZ(bmi, months, input.sex);

  let statusKey: StatusKey = 'baseline';
  if (isAdult) {
    if (bmi < MOCK_THRESHOLDS.adult.closelyLow || bmi >= MOCK_THRESHOLDS.adult.closelyHigh) {
      statusKey = 'monitor_closely';
    } else if (bmi < MOCK_THRESHOLDS.adult.monitorLow || bmi >= MOCK_THRESHOLDS.adult.monitorHigh) {
      statusKey = 'monitor';
    }
  } else if (bmiZ != null) {
    const absZ = Math.abs(bmiZ);
    if (absZ >= MOCK_THRESHOLDS.child.closelyZ) {
      statusKey = 'monitor_closely';
    } else if (absZ >= MOCK_THRESHOLDS.child.monitorZ) {
      statusKey = 'monitor';
    }
  }

  return { statusKey, bmi, bmiZ, isAdult };
}

export function classifyWhtrStatus(input: {
  waistCm: number | null | undefined;
  heightCm: number | null | undefined;
}): { statusKey: StatusKey; whtr: number } | null {
  if (input.waistCm == null || input.heightCm == null || input.waistCm <= 0 || input.heightCm <= 0) {
    return null;
  }
  const whtr = computeWhtr(input.waistCm, input.heightCm);
  if (whtr == null) return null;

  let statusKey: StatusKey = 'baseline';
  if (whtr > MOCK_THRESHOLDS.whtr.closely) {
    statusKey = 'monitor_closely';
  } else if (whtr > MOCK_THRESHOLDS.whtr.monitor) {
    statusKey = 'monitor';
  }

  return { statusKey, whtr };
}

export function classifyMuacStatus(input: {
  muacCm: number | null | undefined;
  birthMonth: number;
  birthYear: number;
  asOf: string;
}): { statusKey: StatusKey; muacCm: number } | null {
  if (input.muacCm == null || input.muacCm <= 0) {
    return null;
  }

  const months = ageInMonths(input.birthMonth, input.birthYear, input.asOf);
  const tier =
    months < 60
      ? MOCK_THRESHOLDS.muac.u5
      : months < 120
      ? MOCK_THRESHOLDS.muac.child5to9
      : months < ADULT_AGE_MONTHS
      ? MOCK_THRESHOLDS.muac.adolescent10to17
      : MOCK_THRESHOLDS.muac.adult;

  let statusKey: StatusKey = 'baseline';
  if (input.muacCm < tier.closely) {
    statusKey = 'monitor_closely';
  } else if (input.muacCm < tier.monitor) {
    statusKey = 'monitor';
  }

  return { statusKey, muacCm: round(input.muacCm, 1) };
}

export function classifyEdemaStatus(
  edema: boolean | number | null | undefined
): { statusKey: StatusKey; edema: boolean } | null {
  if (edema == null) return null;
  const present = Boolean(edema);
  return {
    statusKey: present ? 'monitor_closely' : 'baseline',
    edema: present,
  };
}

// ---------------------------------------------------------------------------
// Signed changes (*_change columns in per-metric status tables)
// Positive = moved toward healthy; negative = moved away; null on first row.
// ---------------------------------------------------------------------------

export function computeBmiSignedChange(params: {
  currBmi: number | null;
  prevBmi: number | null;
  birthMonth: number;
  birthYear: number;
  sex: Sex;
  currDate: string;
  prevDate: string;
}): number | null {
  if (params.currBmi == null || params.prevBmi == null) return null;

  const currMonths = ageInMonths(params.birthMonth, params.birthYear, params.currDate);
  const prevMonths = ageInMonths(params.birthMonth, params.birthYear, params.prevDate);

  if (currMonths >= ADULT_AGE_MONTHS) {
    const ideal = MOCK_THRESHOLDS.adult.idealBmi;
    return clampDecimal6_3(Math.abs(params.prevBmi - ideal) - Math.abs(params.currBmi - ideal));
  }

  const prevZ = approxBmiForAgeZ(params.prevBmi, prevMonths, params.sex);
  const currZ = approxBmiForAgeZ(params.currBmi, currMonths, params.sex);
  if (prevZ == null || currZ == null) return null;
  return clampDecimal6_3(Math.abs(prevZ) - Math.abs(currZ));
}

export function computeWhtrSignedChange(currWhtr: number | null, prevWhtr: number | null): number | null {
  if (currWhtr == null || prevWhtr == null) return null;
  const ideal = MOCK_THRESHOLDS.whtr.ideal;
  return clampDecimal6_3(Math.abs(prevWhtr - ideal) - Math.abs(currWhtr - ideal));
}

export function computeMuacSignedChange(currMuac: number | null, prevMuac: number | null): number | null {
  if (currMuac == null || prevMuac == null) return null;
  return clampDecimal6_3(currMuac - prevMuac);
}

// ---------------------------------------------------------------------------
// Computed-in-code helpers: Outdated (>14d) & Height Notice (<5y & >28d)
// ---------------------------------------------------------------------------

export function getMetricDaysOld(sessionDate: string, today: string): number {
  return daysBetween(sessionDate.slice(0, 10), today.slice(0, 10));
}

export function isMetricOutdated(sessionDate: string, today: string): boolean {
  return getMetricDaysOld(sessionDate, today) > OUTDATED_THRESHOLD_DAYS;
}

export function shouldShowHeightNotice(params: {
  birthMonth: number;
  birthYear: number;
  effectiveHeightDate: string | null | undefined;
  asOfDate: string;
}): boolean {
  if (!params.effectiveHeightDate) return false;
  const months = ageInMonths(params.birthMonth, params.birthYear, params.asOfDate);
  if (months >= HEIGHT_NOTICE_MAX_AGE_MONTHS) return false;
  const heightAgeDays = daysBetween(params.effectiveHeightDate.slice(0, 10), params.asOfDate.slice(0, 10));
  return heightAgeDays > HEIGHT_NOTICE_MAX_AGE_DAYS;
}

// ---------------------------------------------------------------------------
// Past-#-days status transitions report helpers
// ---------------------------------------------------------------------------

export type TransitionDirection = 'improved' | 'declined' | 'unchanged' | 'new';

export function classifyTransitionDirection(
  fromStatus: StatusKey | null,
  toStatus: StatusKey
): TransitionDirection {
  if (fromStatus == null) return 'new';
  const diff = STATUS_SEVERITY[fromStatus] - STATUS_SEVERITY[toStatus];
  if (diff > 0) return 'improved';
  if (diff < 0) return 'declined';
  return 'unchanged';
}

export const TRANSITION_DIRECTION_META: Record<
  TransitionDirection,
  { label: string; badgeClass: string }
> = {
  improved: { label: 'Improved', badgeClass: 'badge-pale-success' },
  declined: { label: 'Declined', badgeClass: 'badge-pale-danger' },
  unchanged: { label: 'Unchanged', badgeClass: 'badge-pale-neutral' },
  new: { label: 'New baseline', badgeClass: 'badge-pale-info' },
};

export type MetricStatusHistoryPoint = {
  session_id: string;
  session_date: string;
  status_key: StatusKey;
  change_value: number | null;
};

export type BeneficiaryTransitionEntry = {
  beneficiary_code: string;
  display_name: string;
  fromStatus: StatusKey | null;
  toStatus: StatusKey;
  fromDate: string | null;
  toDate: string;
  changeValue: number | null;
  direction: TransitionDirection;
};

export type MetricTransitionReport = {
  metric: MetricKey;
  windowStart: string;
  windowEnd: string;
  measuredInWindowCount: number;
  noNewMeasurementCount: number;
  improvedCount: number;
  declinedCount: number;
  unchangedCount: number;
  newCount: number;
  entries: BeneficiaryTransitionEntry[];
};

/**
 * Computes the "Past N days" status transitions report for one metric.
 * Window = [windowStart, today] inclusive, where windowStart = today - lookbackDays.
 * - Looks only at beneficiaries who got a new submitted row inside the window.
 * - `fromStatus` is the most recent row strictly before that window's start (or before the earliest in-window row), or null ("new").
 * - `toStatus` is the newest row inside the window.
 * - Everyone else eligible (registered on/before windowEnd) is counted in `noNewMeasurementCount`.
 */
export function computePerMetricTransitions(params: {
  metric: MetricKey;
  windowStart: string;
  windowEnd: string;
  beneficiaries: Array<{
    beneficiary_code: string;
    display_name: string;
    registration_date: string;
    history: ReadonlyArray<MetricStatusHistoryPoint>;
  }>;
}): MetricTransitionReport {
  const { metric, windowStart, windowEnd, beneficiaries } = params;
  const entries: BeneficiaryTransitionEntry[] = [];
  let noNewMeasurementCount = 0;
  let improvedCount = 0;
  let declinedCount = 0;
  let unchangedCount = 0;
  let newCount = 0;

  for (const b of beneficiaries) {
    if (b.registration_date.slice(0, 10) > windowEnd) {
      continue;
    }

    const sorted = [...b.history].sort((a, b2) => a.session_date.localeCompare(b2.session_date));
    const inWindow = sorted.filter(
      (h) => h.session_date.slice(0, 10) >= windowStart && h.session_date.slice(0, 10) <= windowEnd
    );

    if (inWindow.length === 0) {
      noNewMeasurementCount++;
      continue;
    }

    const latestInWindow = inWindow[inWindow.length - 1];
    const priorBeforeWindow = sorted.filter(
      (h) => h.session_date.slice(0, 10) <= windowStart && h.session_id !== latestInWindow.session_id
    );
    const prevRow = priorBeforeWindow.length > 0 ? priorBeforeWindow[priorBeforeWindow.length - 1] : null;

    const fromStatus = prevRow ? prevRow.status_key : null;
    const toStatus = latestInWindow.status_key;
    const direction = classifyTransitionDirection(fromStatus, toStatus);

    if (direction === 'improved') improvedCount++;
    else if (direction === 'declined') declinedCount++;
    else if (direction === 'unchanged') unchangedCount++;
    else newCount++;

    entries.push({
      beneficiary_code: b.beneficiary_code,
      display_name: b.display_name,
      fromStatus,
      toStatus,
      fromDate: prevRow ? prevRow.session_date.slice(0, 10) : null,
      toDate: latestInWindow.session_date.slice(0, 10),
      changeValue: latestInWindow.change_value,
      direction,
    });
  }

  const order: Record<TransitionDirection, number> = {
    declined: 0,
    improved: 1,
    new: 2,
    unchanged: 3,
  };
  entries.sort((a, b) => {
    const d = order[a.direction] - order[b.direction];
    if (d !== 0) return d;
    return a.display_name.localeCompare(b.display_name);
  });

  return {
    metric,
    windowStart,
    windowEnd,
    measuredInWindowCount: entries.length,
    noNewMeasurementCount,
    improvedCount,
    declinedCount,
    unchangedCount,
    newCount,
    entries,
  };
}
