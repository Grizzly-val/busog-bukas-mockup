import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFirstToLatestDelta,
  filterBeneficiariesByCriteria,
  summarizeFilteredBeneficiaries,
  type FilterableBeneficiaryRow,
  type MeasurementDeltaRecord,
} from './beneficiarySummary.ts';

describe('computeFirstToLatestDelta', () => {
  it('returns null when fewer than 2 present measurements exist', () => {
    const empty: MeasurementDeltaRecord[] = [];
    assert.equal(computeFirstToLatestDelta(empty, 'weight_kg'), null);

    const singlePresent: MeasurementDeltaRecord[] = [
      { session_date: '2026-01-01', is_present: true, weight_kg: 18.4 },
      { session_date: '2026-01-08', is_present: false, weight_kg: 19.0 }, // absent ignored
      { session_date: '2026-01-15', is_present: true, weight_kg: null },
    ];
    assert.equal(computeFirstToLatestDelta(singlePresent, 'weight_kg'), null);
  });

  it('orders chronologically and computes signed delta and percent change from first to latest', () => {
    const records: MeasurementDeltaRecord[] = [
      { session_date: '2026-02-01', is_present: true, weight_kg: 19.0 },
      { session_date: '2026-01-01', is_present: true, weight_kg: 20.0 },
      { session_date: '2026-01-15', is_present: true, weight_kg: 19.5 },
    ];
    const res = computeFirstToLatestDelta(records, 'weight_kg');
    assert.notEqual(res, null);
    assert.equal(res?.first, 20.0);
    assert.equal(res?.latest, 19.0);
    assert.equal(res?.delta, -1.0);
    assert.equal(res?.pctChange, -5.0);
    assert.equal(res?.isUnchangedAt1Dec, false);
  });

  it('treats values equal after 1-decimal rounding as unchanged to avoid floating-point noise', () => {
    const records: MeasurementDeltaRecord[] = [
      { session_date: '2026-01-01', is_present: true, waist_cm: 52.04 },
      { session_date: '2026-01-15', is_present: true, waist_cm: 51.96 },
    ];
    const res = computeFirstToLatestDelta(records, 'waist_cm');
    assert.notEqual(res, null);
    assert.equal(res?.isUnchangedAt1Dec, true);
    assert.equal(res?.delta, 0);
    assert.equal(res?.pctChange, 0);
  });
});

describe('summarizeFilteredBeneficiaries', () => {
  it('handles an empty selection with null means and small-sample warning', () => {
    const summary = summarizeFilteredBeneficiaries([]);
    assert.equal(summary.totalMatching, 0);
    assert.equal(summary.smallSampleWarning, true);

    for (const metric of [summary.weight, summary.waist, summary.muac]) {
      assert.equal(metric.increased.n, 0);
      assert.equal(metric.increased.mean, null);
      assert.equal(metric.decreased.n, 0);
      assert.equal(metric.decreased.mean, null);
      assert.equal(metric.unchangedCount, 0);
      assert.equal(metric.noDataCount, 0);
    }
  });

  it('correctly classifies ties/unchanged, missing data, increased/decreased means, and reconciles counts', () => {
    const rows: Array<{ measurements: MeasurementDeltaRecord[] }> = [
      // 1. Increased weight (+1.2), decreased waist (-1.0), increased MUAC (+0.4)
      {
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 20.0, waist_cm: 50.0, muac_cm: 15.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 21.2, waist_cm: 49.0, muac_cm: 15.4 },
        ],
      },
      // 2. Increased weight (+0.8), decreased waist (-2.0), unchanged MUAC at 1-decimal (14.21 -> 14.19)
      {
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 18.0, waist_cm: 48.0, muac_cm: 14.21 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 18.8, waist_cm: 46.0, muac_cm: 14.19 },
        ],
      },
      // 3. Decreased weight (-0.5), unchanged waist (51.0 -> 51.0), decreased MUAC (-0.6)
      {
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 25.0, waist_cm: 51.0, muac_cm: 16.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 24.5, waist_cm: 51.0, muac_cm: 15.4 },
        ],
      },
      // 4. Unchanged weight (30.02 -> 29.98), increased waist (+1.5), no paired MUAC (only 1 record)
      {
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 30.02, waist_cm: 55.0, muac_cm: 17.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 29.98, waist_cm: 56.5, muac_cm: null },
        ],
      },
      // 5. Missing paired data for all metrics (only 1 present session)
      {
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 22.0, waist_cm: 52.0, muac_cm: null },
        ],
      },
    ];

    const summary = summarizeFilteredBeneficiaries(rows);
    assert.equal(summary.totalMatching, 5);
    assert.equal(summary.smallSampleWarning, false);

    // Weight: 2 increased (+1.2, +0.8 -> mean +1.0), 1 decreased (-0.5), 1 unchanged, 1 no-data
    assert.equal(summary.weight.increased.n, 2);
    assert.equal(summary.weight.increased.mean, 1.0);
    assert.equal(summary.weight.decreased.n, 1);
    assert.equal(summary.weight.decreased.mean, -0.5);
    assert.equal(summary.weight.unchangedCount, 1);
    assert.equal(summary.weight.noDataCount, 1);

    // Waist: 1 increased (+1.5), 2 decreased (-1.0, -2.0 -> mean -1.5), 1 unchanged, 1 no-data
    assert.equal(summary.waist.increased.n, 1);
    assert.equal(summary.waist.increased.mean, 1.5);
    assert.equal(summary.waist.decreased.n, 2);
    assert.equal(summary.waist.decreased.mean, -1.5);
    assert.equal(summary.waist.unchangedCount, 1);
    assert.equal(summary.waist.noDataCount, 1);

    // MUAC: 1 increased (+0.4), 1 decreased (-0.6), 1 unchanged, 2 no-data
    assert.equal(summary.muac.increased.n, 1);
    assert.equal(summary.muac.increased.mean, 0.4);
    assert.equal(summary.muac.decreased.n, 1);
    assert.equal(summary.muac.decreased.mean, -0.6);
    assert.equal(summary.muac.unchangedCount, 1);
    assert.equal(summary.muac.noDataCount, 2);

    // Reconciliation: increased.n + decreased.n + unchangedCount + noDataCount === totalMatching
    for (const metric of [summary.weight, summary.waist, summary.muac]) {
      const reconciledTotal =
        metric.increased.n + metric.decreased.n + metric.unchangedCount + metric.noDataCount;
      assert.equal(reconciledTotal, summary.totalMatching);
    }
  });

  it('filters strictly by attended_count > x (blank = no filter) before summarizing', () => {
    const sampleCohort: FilterableBeneficiaryRow[] = [
      {
        latest_status: 'baseline',
        isAdult: false,
        sex: 'female',
        needs_measurement_warning: false,
        attended_count: 2,
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 18.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 19.0 },
        ],
      },
      {
        latest_status: 'monitor',
        isAdult: false,
        sex: 'male',
        needs_measurement_warning: false,
        attended_count: 3,
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 20.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 21.0 },
        ],
      },
      {
        latest_status: 'monitor_closely',
        isAdult: false,
        sex: 'female',
        needs_measurement_warning: true,
        attended_count: 5,
        measurements: [
          { session_date: '2026-01-01', is_present: true, weight_kg: 16.0 },
          { session_date: '2026-02-01', is_present: true, weight_kg: 15.4 },
        ],
      },
    ];

    // Blank threshold -> all 3 match
    const allMatching = filterBeneficiariesByCriteria(sampleCohort, { minAttendedSessions: '   ' });
    assert.equal(allMatching.length, 3);

    // Strictly greater than 3 (attended_count > 3) -> only attended_count === 5 matches (attended_count === 3 is excluded)
    const gt3 = filterBeneficiariesByCriteria(sampleCohort, { minAttendedSessions: '3' });
    assert.equal(gt3.length, 1);
    assert.equal(gt3[0].attended_count, 5);

    const summaryGt3 = summarizeFilteredBeneficiaries(gt3);
    assert.equal(summaryGt3.totalMatching, 1);
    assert.equal(summaryGt3.weight.decreased.n, 1);
    assert.equal(summaryGt3.weight.decreased.mean, -0.6);
  });
});
