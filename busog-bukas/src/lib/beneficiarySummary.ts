export type DeltaMetricKey = 'weight_kg' | 'waist_cm' | 'muac_cm';

export type MeasurementDeltaRecord = {
  session_date: string;
  is_present: boolean | number;
  weight_kg?: number | null;
  waist_cm?: number | null;
  muac_cm?: number | null;
};

export type FirstToLatestDeltaResult = {
  first: number;
  latest: number;
  delta: number;
  pctChange: number | null;
  isUnchangedAt1Dec: boolean;
};

/**
 * Computes the change from the first ever valid measurement to the latest valid measurement
 * for a given metric key ('weight_kg' | 'waist_cm' | 'muac_cm').
 *
 * Rules:
 * - Only present sessions (`Boolean(r.is_present)`) with a non-null numeric value for `key` count.
 * - Records are ordered chronologically by `session_date` ascending.
 * - Returns `null` when fewer than 2 valid measurements exist.
 * - Values that are equal after rounding to 1 decimal place (`Math.round(v * 10)`) are treated
 *   as unchanged (`delta = 0`, `isUnchangedAt1Dec = true`) to avoid floating-point noise.
 */
export function computeFirstToLatestDelta(
  records: ReadonlyArray<MeasurementDeltaRecord>,
  key: DeltaMetricKey
): FirstToLatestDeltaResult | null {
  const valid = records
    .filter((r) => Boolean(r.is_present) && r[key] != null && !Number.isNaN(Number(r[key])))
    .slice()
    .sort((a, b) => a.session_date.localeCompare(b.session_date));

  if (valid.length < 2) {
    return null;
  }

  const first = Number(valid[0][key]);
  const latest = Number(valid[valid.length - 1][key]);

  const firstDec = Math.round(first * 10);
  const latestDec = Math.round(latest * 10);
  const isUnchangedAt1Dec = firstDec === latestDec;

  const rawDelta = isUnchangedAt1Dec ? 0 : Math.round((latest - first) * 1000) / 1000;
  const pctChange =
    first > 0
      ? isUnchangedAt1Dec
        ? 0
        : Math.round(((latest - first) / first) * 1000) / 10
      : null;

  return {
    first,
    latest,
    delta: rawDelta,
    pctChange,
    isUnchangedAt1Dec,
  };
}

export type DirectionGroupSummary = {
  n: number;
  mean: number | null;
};

export type MetricCohortSummary = {
  key: DeltaMetricKey;
  label: string;
  unit: 'kg' | 'cm';
  increased: DirectionGroupSummary;
  decreased: DirectionGroupSummary;
  unchangedCount: number;
  noDataCount: number;
};

export type FilteredBeneficiariesSummary = {
  totalMatching: number;
  smallSampleWarning: boolean;
  weight: MetricCohortSummary;
  waist: MetricCohortSummary;
  muac: MetricCohortSummary;
};

export type BeneficiaryFilterCriteria = {
  statusFilter?: 'all' | 'baseline' | 'monitor' | 'monitor_closely' | 'unavailable' | 'none';
  ageFilter?: 'all' | 'minor' | 'adult';
  sexFilter?: 'all' | 'female' | 'male';
  warningOnly?: boolean;
  minAttendedSessions?: string | number | null;
};

export type FilterableBeneficiaryRow = {
  latest_status: 'baseline' | 'monitor' | 'monitor_closely' | 'unavailable' | null;
  isAdult: boolean;
  sex: 'female' | 'male';
  needs_measurement_warning: boolean;
  attended_count: number;
  measurements: ReadonlyArray<MeasurementDeltaRecord>;
};

/**
 * Parses the "Attended more than __ sessions" input.
 * Returns null if blank or not a valid finite number.
 */
export function parseMinAttendedThreshold(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pure filter function used by both the Program Beneficiaries table and the Summarize panel
 * (excludes the search box query).
 * Note: `minAttendedSessions` applies strictly greater than (`attended_count > threshold`).
 */
export function filterBeneficiariesByCriteria<T extends FilterableBeneficiaryRow>(
  rows: ReadonlyArray<T>,
  criteria: BeneficiaryFilterCriteria
): T[] {
  const statusFilter = criteria.statusFilter ?? 'all';
  const ageFilter = criteria.ageFilter ?? 'all';
  const sexFilter = criteria.sexFilter ?? 'all';
  const warningOnly = Boolean(criteria.warningOnly);
  const minAttended = parseMinAttendedThreshold(criteria.minAttendedSessions);

  return rows.filter((b) => {
    if (statusFilter !== 'all') {
      if (statusFilter === 'none') {
        if (b.latest_status !== null) return false;
      } else if (b.latest_status !== statusFilter) {
        return false;
      }
    }

    if (ageFilter === 'minor' && b.isAdult) return false;
    if (ageFilter === 'adult' && !b.isAdult) return false;

    if (sexFilter !== 'all' && b.sex !== sexFilter) return false;

    if (warningOnly && !b.needs_measurement_warning) return false;

    if (minAttended !== null && !(b.attended_count > minAttended)) return false;

    return true;
  });
}

function computeMean(values: number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round((sum / values.length) * 1000) / 1000;
}

function summarizeSingleMetric(
  rows: ReadonlyArray<{ measurements: ReadonlyArray<MeasurementDeltaRecord> }>,
  key: DeltaMetricKey,
  label: string,
  unit: 'kg' | 'cm'
): MetricCohortSummary {
  const increasedDeltas: number[] = [];
  const decreasedDeltas: number[] = [];
  let unchangedCount = 0;
  let noDataCount = 0;

  for (const row of rows) {
    const res = computeFirstToLatestDelta(row.measurements, key);
    if (!res) {
      noDataCount++;
    } else if (res.isUnchangedAt1Dec || res.delta === 0) {
      unchangedCount++;
    } else if (res.delta > 0) {
      increasedDeltas.push(res.delta);
    } else {
      decreasedDeltas.push(res.delta);
    }
  }

  return {
    key,
    label,
    unit,
    increased: {
      n: increasedDeltas.length,
      mean: computeMean(increasedDeltas),
    },
    decreased: {
      n: decreasedDeltas.length,
      mean: computeMean(decreasedDeltas),
    },
    unchangedCount,
    noDataCount,
  };
}

/**
 * Summarizes first-to-latest deltas for Weight (kg), Waist (cm), and MUAC (cm)
 * across the currently filtered beneficiaries.
 */
export function summarizeFilteredBeneficiaries(
  rows: ReadonlyArray<{ measurements: ReadonlyArray<MeasurementDeltaRecord> }>
): FilteredBeneficiariesSummary {
  const totalMatching = rows.length;
  return {
    totalMatching,
    smallSampleWarning: totalMatching < 5,
    weight: summarizeSingleMetric(rows, 'weight_kg', 'Weight', 'kg'),
    waist: summarizeSingleMetric(rows, 'waist_cm', 'Waist', 'cm'),
    muac: summarizeSingleMetric(rows, 'muac_cm', 'MUAC', 'cm'),
  };
}
