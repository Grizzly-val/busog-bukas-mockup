'use client';

import { useState, useMemo } from 'react';
import type { ProgramWeekData } from '@/lib/programData';
import { formatDate } from '@/lib/format';
import { WEEK_STATE_META, SESSION_STATE_META, type SessionState } from '@/lib/timelineRules';

type Props = {
  weeks: ProgramWeekData[];
  hasNutritionist: boolean;
  today: string;
};

type WeeksViewTab = 'trend' | 'breakdown';

const SESSION_DOT_HEX: Record<SessionState, string> = {
  submitted: '#24582a',
  draft: '#956400',
  skipped: '#9ca3af',
  upcoming: '#cbd5e1',
};

function computeWeekWeightedSurveyAvg(week: ProgramWeekData): number | null {
  let totalSum = 0;
  let totalN = 0;
  for (const cat of week.surveys.categories) {
    if (cat.avg != null && cat.n > 0) {
      totalSum += cat.avg * cat.n;
      totalN += cat.n;
    }
  }
  return totalN > 0 ? totalSum / totalN : null;
}

function pctOf(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

export default function WeeksOfProgramSection({ weeks, hasNutritionist }: Props) {
  const displayedWeeks = useMemo(() => {
    let lastScheduledIdx = -1;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].sessions.length > 0) {
        lastScheduledIdx = i;
        break;
      }
    }
    return lastScheduledIdx >= 0 ? weeks.slice(0, lastScheduledIdx + 1) : weeks;
  }, [weeks]);

  const defaultIndex = useMemo(() => {
    if (displayedWeeks.length === 0) return 0;
    const currentIdx = displayedWeeks.findIndex((w) => w.state === 'current');
    if (currentIdx !== -1) return currentIdx;

    for (let i = displayedWeeks.length - 1; i >= 0; i--) {
      if (displayedWeeks[i].has_submitted_data) return i;
    }
    return 0;
  }, [displayedWeeks]);

  const [activeTab, setActiveTab] = useState<WeeksViewTab>('trend');
  const [selectedIndex, setSelectedIndex] = useState<number>(defaultIndex);

  const totalScheduledSessions = useMemo(
    () => displayedWeeks.reduce((sum, w) => sum + w.sessions.length, 0),
    [displayedWeeks]
  );
  const totalSubmittedSessions = useMemo(
    () => displayedWeeks.reduce((sum, w) => sum + w.submitted_session_count, 0),
    [displayedWeeks]
  );

  const trendSummary = useMemo(() => {
    const submitted = displayedWeeks
      .map((w, idx) => ({ week: w, index: idx }))
      .filter(({ week }) => week.has_submitted_data);

    if (submitted.length === 0) {
      return {
        submittedCount: 0,
        avgFillPct: null as number | null,
        avgMeasPct: null as number | null,
        avgSurveyPct: null as number | null,
        best: null as { week: ProgramWeekData; index: number } | null,
        excludesW1Intake: false,
      };
    }

    const avgFillPct = Math.round(
      submitted.reduce((s, x) => s + x.week.attendance.fill_pct, 0) / submitted.length
    );
    const avgMeasPct = Math.round(
      submitted.reduce((s, x) => s + x.week.measurements.coverage_pct, 0) / submitted.length
    );
    const avgSurveyPct = Math.round(
      submitted.reduce((s, x) => s + x.week.surveys.response_rate_pct, 0) / submitted.length
    );

    const postLaunchSubmitted = submitted.filter(({ week }) => week.week_number > 1);
    const bestPool = postLaunchSubmitted.length > 0 ? postLaunchSubmitted : submitted;
    const best = [...bestPool].sort(
      (a, b) =>
        b.week.attendance.fill_pct - a.week.attendance.fill_pct ||
        b.week.measurements.coverage_pct - a.week.measurements.coverage_pct ||
        b.week.surveys.response_rate_pct - a.week.surveys.response_rate_pct
    )[0];

    return {
      submittedCount: submitted.length,
      avgFillPct,
      avgMeasPct,
      avgSurveyPct,
      best,
      excludesW1Intake: postLaunchSubmitted.length > 0,
    };
  }, [displayedWeeks]);

  if (displayedWeeks.length === 0) {
    return (
      <section className="card bb-card mb-4 overflow-hidden">
        <div className="p-5 text-center text-body-secondary small">
          No program weeks generated for this program.
        </div>
      </section>
    );
  }

  const safeIndex = Math.min(Math.max(0, selectedIndex), displayedWeeks.length - 1);
  const selectedWeek = displayedWeeks[safeIndex];
  const weekStateMeta = WEEK_STATE_META[selectedWeek.state];

  const handleSelectWeekNode = (idx: number) => {
    setSelectedIndex(idx);
    setActiveTab('breakdown');
  };

  const handlePrev = () => setSelectedIndex((prev) => Math.max(0, prev - 1));
  const handleNext = () =>
    setSelectedIndex((prev) => Math.min(displayedWeeks.length - 1, prev + 1));

  // Adaptive weekly consistency segments based on submitted sessions (S) in selected week
  const submittedInWeek = selectedWeek.submitted_session_count;
  const eligibleInWeek = selectedWeek.attendance.reach_eligible;
  const cons = selectedWeek.attendance.consistency;

  const consistencySegments = (() => {
    if (submittedInWeek <= 1) {
      return [
        {
          key: 'attended',
          label: 'Attended (1/1)',
          inlineText: `${cons.all_days} attended (${pctOf(cons.all_days, eligibleInWeek)}%)`,
          count: cons.all_days,
          pct: pctOf(cons.all_days, eligibleInWeek),
          color: '#1f9d55',
          textColor: '#24582a',
        },
        {
          key: 'absent',
          label: 'Absent (0/1)',
          inlineText: `${cons.zero_days} absent (${pctOf(cons.zero_days, eligibleInWeek)}%)`,
          count: cons.zero_days,
          pct: pctOf(cons.zero_days, eligibleInWeek),
          color: '#cbd5e1',
          textColor: '#6b7280',
        },
      ];
    }

    if (submittedInWeek === 2) {
      const partialCount = cons.one_day + cons.two_to_three_days;
      return [
        {
          key: 'all',
          label: 'All (2/2)',
          inlineText: '',
          count: cons.all_days,
          pct: pctOf(cons.all_days, eligibleInWeek),
          color: '#1f9d55',
          textColor: '#24582a',
        },
        {
          key: 'partial',
          label: 'Partial (1/2)',
          inlineText: '',
          count: partialCount,
          pct: pctOf(partialCount, eligibleInWeek),
          color: '#d97706',
          textColor: '#855b00',
        },
        {
          key: 'absent',
          label: 'Absent (0/2)',
          inlineText: '',
          count: cons.zero_days,
          pct: pctOf(cons.zero_days, eligibleInWeek),
          color: '#cbd5e1',
          textColor: '#6b7280',
        },
      ];
    }

    return [
      {
        key: 'all',
        label: `All (${submittedInWeek}/${submittedInWeek})`,
        inlineText: '',
        count: cons.all_days,
        pct: pctOf(cons.all_days, eligibleInWeek),
        color: '#1f9d55',
        textColor: '#24582a',
      },
      {
        key: 'partial',
        label:
          submittedInWeek - 1 === 2
            ? 'Partial (2)'
            : `Partial (2–${submittedInWeek - 1})`,
        inlineText: '',
        count: cons.two_to_three_days,
        pct: pctOf(cons.two_to_three_days, eligibleInWeek),
        color: '#3b7a57',
        textColor: '#24582a',
      },
      {
        key: 'single',
        label: `Single (1/${submittedInWeek})`,
        inlineText: '',
        count: cons.one_day,
        pct: pctOf(cons.one_day, eligibleInWeek),
        color: '#d97706',
        textColor: '#855b00',
      },
      {
        key: 'absent',
        label: `Absent (0/${submittedInWeek})`,
        inlineText: '',
        count: cons.zero_days,
        pct: pctOf(cons.zero_days, eligibleInWeek),
        color: '#cbd5e1',
        textColor: '#6b7280',
      },
    ];
  })();

  const consistencyTotal = consistencySegments.reduce((sum, s) => sum + s.count, 0);

  return (
    <section className="card bb-card mb-4 overflow-hidden">
      {/* Header matching Program Nutritional Status */}
      <div className="px-4 pt-4 pb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2">
          <div>
            <div className="d-flex align-items-baseline gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark" style={{ letterSpacing: '-0.015em' }}>
                Weeks of the Program
              </h2>
              <span className="small text-body-secondary bb-num">
                {displayedWeeks.length} week{displayedWeeks.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="text-body-secondary small mb-0" style={{ maxWidth: '66ch' }}>
              Weekly Sunday–Saturday attendance consistency, measurement completeness, and survey averages from submitted sessions.
            </p>
          </div>

          <div className="small text-body-secondary bb-num flex-shrink-0">
            <span className="fw-semibold text-dark">{totalSubmittedSessions}</span> / {totalScheduledSessions} sessions submitted
          </div>
        </div>
      </div>

      <div className="p-4">
        {/* Horizontal Visual Week Stepper */}
        <div className="overflow-x-auto pb-2 mb-4">
          <div
            className="bb-stepper-track mx-auto"
            style={{ minWidth: `${Math.max(displayedWeeks.length * 118, 480)}px`, maxWidth: '960px' }}
          >
            <div className="bb-stepper-line" />
            {displayedWeeks.map((wk, idx) => {
              const isSelected = idx === safeIndex;
              const isCompleted = wk.state === 'completed';
              const isCurrent = wk.state === 'current';
              const stateMeta = WEEK_STATE_META[wk.state];

              let nodeStateClass = 'state-upcoming';
              if (isCompleted) nodeStateClass = 'state-closed';
              else if (isCurrent) nodeStateClass = 'state-open';

              return (
                <button
                  key={wk.week_id}
                  type="button"
                  onClick={() => handleSelectWeekNode(idx)}
                  className={`bb-node-wrapper ${isSelected ? 'is-selected' : ''}`}
                  aria-pressed={isSelected}
                  aria-label={`Week ${wk.week_number} (${stateMeta.label})`}
                >
                  <div className={`bb-node-circle ${nodeStateClass}`}>
                    {isCompleted ? '✓' : `W${wk.week_number}`}
                  </div>
                  <div className="bb-node-meta">
                    <div className="bb-node-title">Week {wk.week_number}</div>
                    <div className="bb-node-date bb-num">
                      {formatDate(wk.week_start_date)} – {formatDate(wk.week_end_date)}
                    </div>
                    <div
                      className="text-body-secondary bb-num mt-1"
                      style={{ fontSize: '0.68rem' }}
                    >
                      {wk.submitted_session_count}/{wk.sessions.length} session
                      {wk.sessions.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Underline Tabs: All-Weeks Trend (default) & Week Breakdown */}
        <div className="bb-tab-bar d-flex flex-wrap justify-content-between align-items-center" role="tablist">
          <div className="d-flex gap-4">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'trend'}
              className={`bb-tab-btn ${activeTab === 'trend' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('trend')}
            >
              All-Weeks Trend{' '}
              <span className="bb-num opacity-75 ms-1">{displayedWeeks.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'breakdown'}
              className={`bb-tab-btn ${activeTab === 'breakdown' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('breakdown')}
            >
              Week Breakdown{' '}
              <span className="bb-num opacity-75 ms-1">Week {selectedWeek.week_number}</span>
            </button>
          </div>

          {activeTab === 'breakdown' && (
            <div className="d-flex align-items-center gap-2 pb-1">
              <button
                type="button"
                className="bb-action-chip py-1 px-2"
                onClick={handlePrev}
                disabled={safeIndex === 0}
                aria-label="Previous program week"
              >
                ‹ Prev
              </button>
              <span className="small text-body-secondary bb-num px-1">
                {safeIndex + 1} / {displayedWeeks.length}
              </span>
              <button
                type="button"
                className="bb-action-chip py-1 px-2"
                onClick={handleNext}
                disabled={safeIndex === displayedWeeks.length - 1}
                aria-label="Next program week"
              >
                Next ›
              </button>
            </div>
          )}
        </div>

        {/* Panel A: All-Weeks Trend (Default) */}
        {activeTab === 'trend' && (
          <div>
            {/* Compact Summary Strip */}
            <div className="bb-trend-summary-strip mb-4">
              <div className="row g-3 align-items-center">
                <div className="col-6 col-md-3 bb-trend-summary-cell">
                  <div className="d-flex align-items-center gap-1 small text-body-secondary">
                    <span className="bb-status-dot me-0" style={{ backgroundColor: '#1f9d55' }} />
                    <span>Avg Attendance Fill</span>
                  </div>
                  <div className="fs-5 fw-bold bb-num text-dark mt-1">
                    {trendSummary.avgFillPct != null ? `${trendSummary.avgFillPct}%` : '—'}
                  </div>
                </div>

                <div className="col-6 col-md-3 bb-trend-summary-cell">
                  <div className="d-flex align-items-center gap-1 small text-body-secondary">
                    <span className="bb-status-dot me-0" style={{ backgroundColor: '#1d5786' }} />
                    <span>Avg Meas Coverage</span>
                  </div>
                  <div className="fs-5 fw-bold bb-num text-dark mt-1">
                    {trendSummary.avgMeasPct != null ? `${trendSummary.avgMeasPct}%` : '—'}
                  </div>
                </div>

                <div className="col-6 col-md-3 bb-trend-summary-cell">
                  <div className="d-flex align-items-center gap-1 small text-body-secondary">
                    <span className="bb-status-dot me-0" style={{ backgroundColor: '#d97706' }} />
                    <span>Avg Survey Response</span>
                  </div>
                  <div className="fs-5 fw-bold bb-num text-dark mt-1">
                    {trendSummary.avgSurveyPct != null ? `${trendSummary.avgSurveyPct}%` : '—'}
                  </div>
                </div>

                <div className="col-6 col-md-3 bb-trend-summary-cell">
                  <div className="small text-body-secondary">Best-Performing Week</div>
                  {trendSummary.best ? (
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() => handleSelectWeekNode(trendSummary.best!.index)}
                        className="btn btn-link p-0 border-0 text-decoration-none fw-bold bb-num"
                        style={{ color: '#0b3d24', fontSize: '1.05rem' }}
                      >
                        Week {trendSummary.best.week.week_number} ›
                      </button>
                      <div className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
                        {trendSummary.best.week.attendance.fill_pct}% fill ·{' '}
                        {trendSummary.best.week.measurements.coverage_pct}% meas
                      </div>
                      <div className="text-body-secondary" style={{ fontSize: '0.69rem' }}>
                        {trendSummary.excludesW1Intake ? 'excludes W1 intake' : 'W1 intake only'}
                      </div>
                    </div>
                  ) : (
                    <div className="fs-5 fw-bold text-body-secondary mt-1">—</div>
                  )}
                </div>
              </div>
            </div>

            {/* Multi-Series SVG Trend Chart */}
            <div className="mb-4 pb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
              <AllWeeksTrendChart weeks={displayedWeeks} onSelectWeek={handleSelectWeekNode} />
            </div>

            {/* All-Weeks Summary Table */}
            <div className="table-responsive">
              <table className="bb-ns-table">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Status</th>
                    <th className="text-end">Submitted</th>
                    <th className="text-end">Attendance</th>
                    <th className="text-end">Measurements</th>
                    <th className="text-end">Surveys (1–5)</th>
                    <th className="text-end" style={{ width: '90px' }}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedWeeks.map((wk, idx) => {
                    const wkMeta = WEEK_STATE_META[wk.state];
                    const weightedSurvey = computeWeekWeightedSurveyAvg(wk);
                    const missingMeasTotal =
                      wk.measurements.missing_weight_count +
                      wk.measurements.missing_waist_count +
                      (hasNutritionist
                        ? wk.measurements.missing_muac_count + wk.measurements.missing_edema_count
                        : 0);

                    return (
                      <tr
                        key={wk.week_id}
                        className="bb-week-trend-row"
                        onClick={() => handleSelectWeekNode(idx)}
                      >
                        <td>
                          <div className="fw-semibold text-dark bb-num">Week {wk.week_number}</div>
                          <div className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
                            {formatDate(wk.week_start_date)} – {formatDate(wk.week_end_date)}
                          </div>
                        </td>
                        <td>
                          <span className={`bb-status-chip ${wkMeta.badgeClass}`}>
                            {wkMeta.label}
                          </span>
                        </td>
                        <td className="text-end bb-num">
                          <span className={wk.has_submitted_data ? 'fw-semibold text-dark' : 'text-body-secondary'}>
                            {wk.submitted_session_count} / {wk.sessions.length}
                          </span>
                        </td>
                        <td className="text-end bb-num">
                          {!wk.has_submitted_data ? (
                            <span className="text-body-secondary">—</span>
                          ) : (
                            <div>
                              <div className="fw-semibold" style={{ color: '#24582a' }}>
                                {wk.attendance.reach_pct}% reach
                              </div>
                              <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                {wk.attendance.reach_attended}/{wk.attendance.reach_eligible}
                                {wk.submitted_session_count > 1 && ` · ${wk.attendance.fill_pct}% fill`}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="text-end bb-num">
                          {!wk.has_submitted_data ? (
                            <span className="text-body-secondary">—</span>
                          ) : (
                            <div>
                              <div className="fw-semibold text-dark">{wk.measurements.coverage_pct}%</div>
                              <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                {wk.measurements.unique_measured_count}/{wk.measurements.unique_present_count} measured
                                {missingMeasTotal > 0 && (
                                  <span className="ms-1" style={{ color: '#855b00' }}>
                                    · {missingMeasTotal} gap{missingMeasTotal === 1 ? '' : 's'}
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="text-end bb-num">
                          {!wk.has_submitted_data ? (
                            <span className="text-body-secondary">—</span>
                          ) : weightedSurvey != null ? (
                            <div>
                              <div className="fw-semibold text-dark">{weightedSurvey.toFixed(2)} / 5</div>
                              <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                {wk.surveys.response_rate_pct}% response
                              </div>
                            </div>
                          ) : (
                            <span className="text-body-secondary">No responses</span>
                          )}
                        </td>
                        <td className="text-end">
                          <button
                            type="button"
                            className="bb-action-chip py-1 px-2"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectWeekNode(idx);
                            }}
                          >
                            View ›
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Panel B: Selected Week Breakdown */}
        {activeTab === 'breakdown' && (
          <div>
            {/* Clean Week Summary Strip (bounded inside p-4 so right counter never clips) */}
            <div
              className="d-flex flex-wrap justify-content-between align-items-start gap-3 pb-3 mb-4 border-bottom"
              style={{ borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="d-flex flex-wrap align-items-center gap-2 mb-2">
                  <h3 className="h6 fw-bold mb-0 text-dark bb-num">
                    Week {selectedWeek.week_number}
                  </h3>
                  <span className={`bb-status-chip ${weekStateMeta.badgeClass}`}>
                    {weekStateMeta.label}
                  </span>
                  <span className="small text-body-secondary bb-num">
                    {formatDate(selectedWeek.week_start_date)} – {formatDate(selectedWeek.week_end_date)}
                  </span>
                </div>
                <div className="d-flex flex-wrap gap-2">
                  {selectedWeek.sessions.length === 0 ? (
                    <span className="small text-body-secondary">No sessions scheduled this week.</span>
                  ) : (
                    selectedWeek.sessions.map((s) => {
                      const sm = SESSION_STATE_META[s.state];
                      return (
                        <span
                          key={s.session_id}
                          className="d-inline-flex align-items-center gap-1 px-2 py-1 rounded border bg-white small"
                          style={{ borderColor: 'rgba(0,0,0,0.08)', fontSize: '0.75rem' }}
                        >
                          <span
                            className="bb-status-dot me-1"
                            style={{ backgroundColor: SESSION_DOT_HEX[s.state] }}
                          />
                          <span className="bb-num fw-medium text-dark">{formatDate(s.session_date)}</span>
                          <span className="text-body-secondary">· {sm.label}</span>
                        </span>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="flex-shrink-0 text-sm-end pe-1">
                <div className="small text-body-secondary">Submitted sessions</div>
                <div className="fw-bold fs-5 bb-num text-dark">
                  {selectedWeek.submitted_session_count} / {selectedWeek.sessions.length}
                </div>
              </div>
            </div>

            {!selectedWeek.has_submitted_data ? (
              <div
                className="text-center text-body-secondary small py-4 px-3 rounded"
                style={{ border: '1px dashed rgba(0,0,0,0.12)', background: '#fbfbfa' }}
              >
                No submitted sessions in Week {selectedWeek.week_number} yet. Attendance consistency, measurement completeness, and survey outcomes compute from submitted sessions only.
              </div>
            ) : (
              <div className="row g-0">
                {/* Group 1: Attendance & Adaptive Consistency */}
                <div className="col-12 col-xl-4 bb-week-col d-flex flex-column">
                  <div
                    className="d-flex justify-content-between align-items-baseline pb-2 mb-3 border-bottom"
                    style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                  >
                    <h4 className="h6 fw-semibold mb-0 text-dark">Attendance</h4>
                    <span className="small text-body-secondary bb-num">
                      {eligibleInWeek} eligible
                    </span>
                  </div>

                  {/* Top Attendance Figures: avoid duplicate Reach/Fill when S = 1 */}
                  {submittedInWeek === 1 ? (
                    <div
                      className="pb-3 mb-3 border-bottom"
                      style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                    >
                      <div className="d-flex justify-content-between align-items-baseline">
                        <div>
                          <div className="small text-body-secondary">Session Attendance</div>
                          <div className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                            {selectedWeek.attendance.reach_attended} / {eligibleInWeek} eligible enrollees
                          </div>
                        </div>
                        <div className="fs-4 fw-bold bb-num" style={{ color: '#24582a' }}>
                          {selectedWeek.attendance.reach_pct}%
                        </div>
                      </div>
                      <div
                        className="bb-num mt-1"
                        style={{
                          fontSize: '0.74rem',
                          color: selectedWeek.attendance.new_registrations_count > 0 ? '#24582a' : '#6b7280',
                        }}
                      >
                        {selectedWeek.attendance.new_registrations_count} new registration
                        {selectedWeek.attendance.new_registrations_count === 1 ? '' : 's'}
                      </div>
                    </div>
                  ) : (
                    <div
                      className="pb-3 mb-3 border-bottom"
                      style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                    >
                      <div className="row g-3">
                        <div className="col-6">
                          <div className="small text-body-secondary">Reach (≥1 day)</div>
                          <div className="fs-5 fw-bold bb-num" style={{ color: '#24582a' }}>
                            {selectedWeek.attendance.reach_pct}%
                          </div>
                          <div className="text-body-secondary bb-num" style={{ fontSize: '0.74rem' }}>
                            {selectedWeek.attendance.reach_attended} / {eligibleInWeek} enrollees
                          </div>
                        </div>
                        <div className="col-6 border-start" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                          <div className="small text-body-secondary">Slot Fill Rate</div>
                          <div className="fs-5 fw-bold bb-num text-dark">
                            {selectedWeek.attendance.fill_pct}%
                          </div>
                          <div className="text-body-secondary bb-num" style={{ fontSize: '0.74rem' }}>
                            {selectedWeek.attendance.fill_check_ins} / {selectedWeek.attendance.fill_eligible_slots} slots
                          </div>
                        </div>
                      </div>
                      <div
                        className="bb-num mt-2"
                        style={{
                          fontSize: '0.74rem',
                          color: selectedWeek.attendance.new_registrations_count > 0 ? '#24582a' : '#6b7280',
                        }}
                      >
                        {selectedWeek.attendance.new_registrations_count} new registration
                        {selectedWeek.attendance.new_registrations_count === 1 ? '' : 's'}
                      </div>
                    </div>
                  )}

                  {/* Adaptive Weekly Consistency Visualization */}
                  <div className="mb-3">
                    <div className="d-flex justify-content-between align-items-baseline mb-2">
                      <span className="small fw-semibold text-dark">Weekly Consistency</span>
                      <span className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                        {submittedInWeek} submitted session{submittedInWeek === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div
                      className="bb-consistency-bar mb-2"
                      role="img"
                      aria-label={`Weekly attendance consistency across ${eligibleInWeek} eligible enrollees`}
                    >
                      {consistencySegments.map((seg) => {
                        if (seg.count <= 0 || consistencyTotal <= 0) return null;
                        const widthPct = (seg.count / consistencyTotal) * 100;
                        return (
                          <div
                            key={seg.key}
                            style={{
                              width: `${widthPct}%`,
                              backgroundColor: seg.color,
                            }}
                            title={`${seg.label}: ${seg.count} (${seg.pct}%)`}
                          />
                        );
                      })}
                    </div>

                    {submittedInWeek <= 1 ? (
                      <div className="d-flex justify-content-between align-items-center small bb-num pt-1">
                        <span className="d-inline-flex align-items-center gap-1 fw-medium" style={{ color: '#24582a' }}>
                          <span className="bb-status-dot me-0" style={{ backgroundColor: '#1f9d55' }} />
                          <span>{consistencySegments[0].inlineText}</span>
                        </span>
                        <span className="d-inline-flex align-items-center gap-1 text-body-secondary">
                          <span className="bb-status-dot me-0" style={{ backgroundColor: '#cbd5e1' }} />
                          <span>{consistencySegments[1].inlineText}</span>
                        </span>
                      </div>
                    ) : (
                      <div className="mt-2">
                        {consistencySegments.map((seg) => (
                          <div
                            key={seg.key}
                            className="bb-hairline-row d-flex justify-content-between align-items-center py-1 small"
                          >
                            <span className="d-inline-flex align-items-center gap-2 text-body-secondary">
                              <span
                                className="bb-status-dot me-0"
                                style={{ backgroundColor: seg.color }}
                              />
                              <span>{seg.label}</span>
                            </span>
                            <span className="bb-num">
                              <strong style={{ color: seg.textColor }}>{seg.count}</strong>
                              <span className="text-body-secondary ms-1">({seg.pct}%)</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Best & Lowest Callout (only when >1 session in week) + Session Table */}
                  <div className="mt-auto">
                    {selectedWeek.attendance.best_day && selectedWeek.attendance.per_day.length > 1 && (
                      <div
                        className="d-flex flex-wrap justify-content-between gap-2 pb-2 mb-2 border-bottom text-body-secondary bb-num"
                        style={{ borderColor: 'rgba(0,0,0,0.06)', fontSize: '0.73rem' }}
                      >
                        <span style={{ color: '#24582a' }}>
                          Best: {formatDate(selectedWeek.attendance.best_day.session_date)} (
                          {selectedWeek.attendance.best_day.pct}%)
                        </span>
                        {selectedWeek.attendance.lowest_day && (
                          <span style={{ color: '#855b00' }}>
                            Lowest: {formatDate(selectedWeek.attendance.lowest_day.session_date)} (
                            {selectedWeek.attendance.lowest_day.pct}%)
                          </span>
                        )}
                      </div>
                    )}

                    <div className="table-responsive">
                      <table className="bb-ns-table">
                        <thead>
                          <tr>
                            <th className="px-1">Session</th>
                            <th className="text-end px-1">Present</th>
                            <th className="text-end px-1">Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedWeek.attendance.per_day.map((day) => (
                            <tr key={day.session_id}>
                              <td className="bb-num px-1 py-2">{formatDate(day.session_date)}</td>
                              <td className="text-end bb-num px-1 py-2 text-body-secondary">
                                {day.present_count}/{day.eligible_count}
                              </td>
                              <td className="text-end bb-num px-1 py-2 fw-semibold text-dark">
                                {day.pct}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Group 2: Measurements (Slim Horizontal Completion Bars) */}
                <div className="col-12 col-xl-4 bb-week-col d-flex flex-column">
                  <div
                    className="d-flex justify-content-between align-items-baseline pb-2 mb-3 border-bottom"
                    style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                  >
                    <h4 className="h6 fw-semibold mb-0 text-dark">Measurements</h4>
                    <span
                      className="small bb-num fw-medium"
                      style={{
                        color:
                          selectedWeek.measurements.zero_measurement_sessions_count > 0
                            ? '#9f2f2d'
                            : '#24582a',
                      }}
                    >
                      {selectedWeek.measurements.zero_measurement_sessions_count} zero-meas session
                      {selectedWeek.measurements.zero_measurement_sessions_count === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="pb-3 mb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                    <div className="d-flex justify-content-between align-items-baseline mb-1">
                      <span className="small text-body-secondary">Unique coverage</span>
                      <span className="fs-5 fw-bold bb-num" style={{ color: '#24582a' }}>
                        {selectedWeek.measurements.coverage_pct}%
                      </span>
                    </div>
                    <div className="bb-meter-track mb-1">
                      <div
                        className="bb-meter-fill"
                        style={{ width: `${selectedWeek.measurements.coverage_pct}%` }}
                      />
                    </div>
                    <div className="text-body-secondary bb-num" style={{ fontSize: '0.74rem' }}>
                      {selectedWeek.measurements.unique_measured_count} of{' '}
                      {selectedWeek.measurements.unique_present_count} attendees had ≥1 measurement
                    </div>
                  </div>

                  {/* Slim horizontal completion bars per metric */}
                  <div className="mb-3">
                    <div className="small fw-semibold text-dark mb-2">Completion by Metric</div>
                    <div>
                      {(() => {
                        const totalAttendees = selectedWeek.measurements.unique_present_count;
                        const items = [
                          {
                            label: 'Weight',
                            missing: selectedWeek.measurements.missing_weight_count,
                          },
                          {
                            label: 'Waist',
                            missing: selectedWeek.measurements.missing_waist_count,
                          },
                          ...(hasNutritionist
                            ? [
                                {
                                  label: 'MUAC',
                                  missing: selectedWeek.measurements.missing_muac_count,
                                },
                                {
                                  label: 'Edema',
                                  missing: selectedWeek.measurements.missing_edema_count,
                                },
                              ]
                            : []),
                        ];

                        return items.map((item) => {
                          const measured = Math.max(0, totalAttendees - item.missing);
                          const fillPct =
                            totalAttendees > 0 ? Math.round((measured / totalAttendees) * 100) : 0;
                          const isUnrecorded = measured === 0;

                          return (
                            <div key={item.label} className="py-1 mb-1">
                              <div className="d-flex justify-content-between align-items-baseline small mb-1">
                                <span className={isUnrecorded ? 'text-body-secondary' : 'fw-medium text-dark'}>
                                  {item.label}
                                </span>
                                {isUnrecorded ? (
                                  <span className="text-body-secondary bb-num" style={{ fontSize: '0.74rem' }}>
                                    Not recorded this week · 0/{totalAttendees}
                                  </span>
                                ) : (
                                  <span className="bb-num" style={{ fontSize: '0.76rem' }}>
                                    <strong className="text-dark">
                                      {measured}/{totalAttendees}
                                    </strong>
                                    <span
                                      className="ms-1"
                                      style={{ color: item.missing > 0 ? '#855b00' : '#6b7280' }}
                                    >
                                      {item.missing > 0 ? `· ${item.missing} missing` : '· Complete'}
                                    </span>
                                  </span>
                                )}
                              </div>
                              <div className="bb-meter-track">
                                <div
                                  className="bb-meter-fill"
                                  style={{
                                    width: `${fillPct}%`,
                                    opacity: isUnrecorded ? 0 : 1,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>

                  <div className="mt-auto">
                    <div className="table-responsive">
                      <table className="bb-ns-table">
                        <thead>
                          <tr>
                            <th className="px-1">Date</th>
                            <th className="text-end px-1">Meas</th>
                            <th className="text-end px-1">Wt</th>
                            <th className="text-end px-1">Wst</th>
                            {hasNutritionist && <th className="text-end px-1">M/E</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {selectedWeek.measurements.per_day.map((d) => (
                            <tr key={d.session_id}>
                              <td className="bb-num px-1 py-2">
                                {formatDate(d.session_date)}
                                {d.zero_measurements && (
                                  <span className="ms-1 fw-semibold" style={{ color: '#9f2f2d', fontSize: '0.7rem' }}>
                                    (0)
                                  </span>
                                )}
                              </td>
                              <td className="text-end bb-num px-1 py-2 fw-semibold text-dark">
                                {d.measured_count}/{d.present_count}
                              </td>
                              <td className="text-end bb-num px-1 py-2 text-body-secondary">
                                {d.weight_count}
                              </td>
                              <td className="text-end bb-num px-1 py-2 text-body-secondary">
                                {d.waist_count}
                              </td>
                              {hasNutritionist && (
                                <td className="text-end bb-num px-1 py-2 text-body-secondary">
                                  {d.muac_count}/{d.edema_count}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Group 3: Surveys (Empty state or Category Bars with Prior-Week Tick) */}
                <div className="col-12 col-xl-4 bb-week-col d-flex flex-column">
                  <div
                    className="d-flex justify-content-between align-items-baseline pb-2 mb-3 border-bottom"
                    style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                  >
                    <h4 className="h6 fw-semibold mb-0 text-dark">Surveys (1–5 Scale)</h4>
                    <span className="small text-body-secondary bb-num">
                      {selectedWeek.surveys.response_rate_pct}% response
                    </span>
                  </div>

                  <div className="pb-3 mb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                    <div className="d-flex justify-content-between align-items-baseline">
                      <span className="small text-body-secondary">Unique Respondents</span>
                      <span className="fs-5 fw-bold bb-num text-dark">
                        {selectedWeek.surveys.respondent_count} / {selectedWeek.surveys.attendee_count}
                      </span>
                    </div>
                    <div className="text-body-secondary" style={{ fontSize: '0.74rem' }}>
                      Unique attendees submitting ≥1 rating this week
                    </div>
                  </div>

                  {selectedWeek.surveys.respondent_count === 0 ? (
                    <div
                      className="text-center text-body-secondary small py-4 px-3 rounded my-auto"
                      style={{ border: '1px dashed rgba(0,0,0,0.1)', background: '#fbfbfa' }}
                    >
                      No survey responses recorded this week.
                    </div>
                  ) : (
                    <>
                      {selectedWeek.surveys.lowest_category && (
                        <div
                          className="pb-3 mb-3 border-bottom"
                          style={{ borderColor: 'rgba(0,0,0,0.06)' }}
                        >
                          <div className="d-flex justify-content-between align-items-baseline">
                            <span className="small fw-medium text-dark">
                              Lowest: {selectedWeek.surveys.lowest_category.label}
                            </span>
                            <span className="bb-num fw-bold text-dark">
                              {selectedWeek.surveys.lowest_category.avg?.toFixed(2)} / 5
                            </span>
                          </div>
                          <div className="small text-body-secondary bb-num mt-1" style={{ fontSize: '0.74rem' }}>
                            {selectedWeek.surveys.lowest_category.delta == null ? (
                              'No prior week score for comparison'
                            ) : selectedWeek.surveys.lowest_category.delta > 0 ? (
                              <span style={{ color: '#24582a' }}>
                                +{selectedWeek.surveys.lowest_category.delta.toFixed(2)} vs last week
                              </span>
                            ) : selectedWeek.surveys.lowest_category.delta < 0 ? (
                              <span style={{ color: '#9f2f2d' }}>
                                {selectedWeek.surveys.lowest_category.delta.toFixed(2)} vs last week
                              </span>
                            ) : (
                              <span>0.00 vs last week (unchanged)</span>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="mt-auto">
                        <div className="d-flex justify-content-between align-items-baseline mb-2">
                          <span className="small fw-semibold text-dark">Pooled Category Averages</span>
                          {selectedWeek.surveys.categories.some((c) => c.prev_avg != null) && (
                            <span className="text-body-secondary" style={{ fontSize: '0.71rem' }}>
                              <span
                                className="d-inline-block me-1 align-middle"
                                style={{ width: 2, height: 9, backgroundColor: '#1a1e1b' }}
                              />
                              Last week avg
                            </span>
                          )}
                        </div>
                        <div>
                          {selectedWeek.surveys.categories.map((cat) => {
                            const pctWidth =
                              cat.avg != null ? Math.min(100, Math.max(0, (cat.avg / 5) * 100)) : 0;
                            const prevTickPct =
                              cat.prev_avg != null
                                ? Math.min(100, Math.max(0, (cat.prev_avg / 5) * 100))
                                : null;

                            return (
                              <div key={cat.question_id} className="bb-hairline-row py-2">
                                <div className="d-flex justify-content-between align-items-baseline small mb-1">
                                  <span className="fw-medium text-dark">{cat.label}</span>
                                  <span className="bb-num">
                                    {cat.avg != null ? (
                                      <>
                                        <strong className="text-dark">{cat.avg.toFixed(2)}</strong>
                                        <span className="text-body-secondary ms-1">(n={cat.n})</span>
                                        {cat.delta != null && (
                                          <span
                                            className="ms-2"
                                            style={{
                                              color:
                                                cat.delta > 0
                                                  ? '#24582a'
                                                  : cat.delta < 0
                                                  ? '#9f2f2d'
                                                  : '#6b7280',
                                            }}
                                          >
                                            {cat.delta > 0
                                              ? `+${cat.delta.toFixed(2)}`
                                              : cat.delta.toFixed(2)}
                                          </span>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-body-secondary">No responses (n=0)</span>
                                    )}
                                  </span>
                                </div>
                                <div className="bb-survey-meter-wrap">
                                  <div className="bb-meter-track">
                                    <div
                                      className="bb-meter-fill"
                                      style={{ width: `${pctWidth}%` }}
                                    />
                                  </div>
                                  {prevTickPct != null && (
                                    <span
                                      className="bb-survey-prev-tick"
                                      style={{ left: `${prevTickPct}%` }}
                                      title={`Last week: ${cat.prev_avg!.toFixed(2)} / 5`}
                                    />
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Multi-Series Trend Chart Across All Program Weeks
// ---------------------------------------------------------------------------

function buildSeriesSegments(points: Array<{ x: number; y: number } | null>): string[] {
  const paths: string[] = [];
  let current: Array<{ x: number; y: number }> = [];

  for (const pt of points) {
    if (pt) {
      current.push(pt);
    } else if (current.length > 0) {
      if (current.length >= 2) {
        paths.push(
          current
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
            .join(' ')
        );
      }
      current = [];
    }
  }

  if (current.length >= 2) {
    paths.push(
      current
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ')
    );
  }

  return paths;
}

type TrendSeriesKey = 'fill' | 'meas' | 'survey';

function AllWeeksTrendChart({
  weeks,
  onSelectWeek,
}: {
  weeks: ProgramWeekData[];
  onSelectWeek: (idx: number) => void;
}) {
  const [visibleSeries, setVisibleSeries] = useState<Record<TrendSeriesKey, boolean>>({
    fill: true,
    meas: true,
    survey: true,
  });

  const toggleSeries = (key: TrendSeriesKey) => {
    setVisibleSeries((prev) => {
      const activeCount = Object.values(prev).filter(Boolean).length;
      if (prev[key] && activeCount <= 1) return prev;
      return { ...prev, [key]: !prev[key] };
    });
  };

  const SVG_W = 860;
  const SVG_H = 236;
  const LEFT_PAD = 42;
  const RIGHT_PAD = 22;
  const TOP_PAD = 18;
  const BOTTOM_PAD = 44;
  const PLOT_W = SVG_W - LEFT_PAD - RIGHT_PAD;
  const PLOT_H = SVG_H - TOP_PAD - BOTTOM_PAD;
  const X_INSET = weeks.length > 1 ? 30 : PLOT_W / 2;

  const yForPct = (pct: number) => TOP_PAD + (1 - Math.min(100, Math.max(0, pct)) / 100) * PLOT_H;
  const xForIdx = (idx: number) => {
    if (weeks.length <= 1) return LEFT_PAD + PLOT_W / 2;
    return LEFT_PAD + X_INSET + (idx / (weeks.length - 1)) * (PLOT_W - X_INSET * 2);
  };

  const colSpacing = weeks.length > 1 ? (PLOT_W - X_INSET * 2) / (weeks.length - 1) : PLOT_W;
  const hitHalfW = Math.min(48, Math.max(20, colSpacing / 2));

  const fillPoints = weeks.map((w, idx) =>
    w.has_submitted_data ? { x: xForIdx(idx), y: yForPct(w.attendance.fill_pct) } : null
  );
  const measPoints = weeks.map((w, idx) =>
    w.has_submitted_data ? { x: xForIdx(idx), y: yForPct(w.measurements.coverage_pct) } : null
  );
  const surveyPoints = weeks.map((w, idx) =>
    w.has_submitted_data ? { x: xForIdx(idx), y: yForPct(w.surveys.response_rate_pct) } : null
  );

  const fillSegments = buildSeriesSegments(fillPoints);
  const measSegments = buildSeriesSegments(measPoints);
  const surveySegments = buildSeriesSegments(surveyPoints);

  return (
    <div>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
        <div className="d-flex flex-wrap align-items-center gap-3 small" role="group" aria-label="Toggle chart series">
          <button
            type="button"
            aria-pressed={visibleSeries.fill}
            onClick={() => toggleSeries('fill')}
            className="btn btn-link p-0 border-0 text-decoration-none d-inline-flex align-items-center gap-2 small"
            style={{
              color: visibleSeries.fill ? '#1a1e1b' : '#6b7280',
              opacity: visibleSeries.fill ? 1 : 0.4,
              fontWeight: visibleSeries.fill ? 500 : 400,
            }}
          >
            <span
              className="d-inline-block"
              style={{ width: 16, height: 2.5, backgroundColor: '#1f9d55', borderRadius: 2 }}
            />
            <span>Attendance Fill Rate</span>
          </button>
          <button
            type="button"
            aria-pressed={visibleSeries.meas}
            onClick={() => toggleSeries('meas')}
            className="btn btn-link p-0 border-0 text-decoration-none d-inline-flex align-items-center gap-2 small"
            style={{
              color: visibleSeries.meas ? '#1a1e1b' : '#6b7280',
              opacity: visibleSeries.meas ? 1 : 0.4,
              fontWeight: visibleSeries.meas ? 500 : 400,
            }}
          >
            <span
              className="d-inline-block"
              style={{ width: 16, height: 2.5, backgroundColor: '#1d5786', borderRadius: 2 }}
            />
            <span>Measurement Coverage</span>
          </button>
          <button
            type="button"
            aria-pressed={visibleSeries.survey}
            onClick={() => toggleSeries('survey')}
            className="btn btn-link p-0 border-0 text-decoration-none d-inline-flex align-items-center gap-2 small"
            style={{
              color: visibleSeries.survey ? '#1a1e1b' : '#6b7280',
              opacity: visibleSeries.survey ? 1 : 0.4,
              fontWeight: visibleSeries.survey ? 500 : 400,
            }}
          >
            <svg width="18" height="4" aria-hidden="true">
              <line
                x1="0"
                y1="2"
                x2="18"
                y2="2"
                stroke="#d97706"
                strokeWidth="2.2"
                strokeDasharray="4 3"
              />
            </svg>
            <span>Survey Response Rate</span>
          </button>
        </div>
        <span className="text-body-secondary" style={{ fontSize: '0.76rem' }}>
          Click legend labels to filter · Click week point for Breakdown
        </span>
      </div>

      <div className="bb-trend-chart-wrap">
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          style={{ width: '100%', minWidth: '580px', height: 'auto', display: 'block' }}
          role="img"
          aria-label="Program weekly trend across attendance fill rate, measurement coverage, and survey response rate"
        >
          {/* Horizontal gridlines */}
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = yForPct(tick);
            return (
              <g key={tick}>
                <line
                  x1={LEFT_PAD}
                  y1={y}
                  x2={SVG_W - RIGHT_PAD}
                  y2={y}
                  stroke={tick === 0 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.06)'}
                  strokeWidth="1"
                />
                <text
                  x={LEFT_PAD - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize="10.5"
                  fill="#6b7280"
                >
                  {tick}%
                </text>
              </g>
            );
          })}

          {/* Multi-series paths */}
          {visibleSeries.survey &&
            surveySegments.map((d, i) => (
              <path
                key={`survey_seg_${i}`}
                d={d}
                fill="none"
                stroke="#d97706"
                strokeWidth="2"
                strokeDasharray="4 3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          {visibleSeries.meas &&
            measSegments.map((d, i) => (
              <path
                key={`meas_seg_${i}`}
                d={d}
                fill="none"
                stroke="#1d5786"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          {visibleSeries.fill &&
            fillSegments.map((d, i) => (
              <path
                key={`fill_seg_${i}`}
                d={d}
                fill="none"
                stroke="#1f9d55"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

          {/* Interactive per-week columns, markers, and X-axis ticks */}
          {weeks.map((wk, idx) => {
            const x = xForIdx(idx);
            const hasData = wk.has_submitted_data;
            const labelY = TOP_PAD + PLOT_H + 16;

            return (
              <g
                key={wk.week_id}
                className="bb-trend-hit-col"
                role="button"
                tabIndex={0}
                onClick={() => onSelectWeek(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectWeek(idx);
                  }
                }}
                aria-label={
                  hasData
                    ? `Week ${wk.week_number}: Fill ${wk.attendance.fill_pct}%, Measurements ${wk.measurements.coverage_pct}%, Surveys ${wk.surveys.response_rate_pct}%`
                    : `Week ${wk.week_number}: No submitted sessions`
                }
              >
                <title>
                  {hasData
                    ? `Week ${wk.week_number} (${formatDate(wk.week_start_date)} – ${formatDate(
                        wk.week_end_date
                      )})\nAttendance Fill: ${wk.attendance.fill_pct}%\nMeasurement Coverage: ${
                        wk.measurements.coverage_pct
                      }%\nSurvey Response: ${wk.surveys.response_rate_pct}%`
                    : `Week ${wk.week_number}: No submitted sessions (${wk.sessions.length} scheduled)`}
                </title>

                <rect
                  x={x - hitHalfW}
                  y={TOP_PAD - 6}
                  width={hitHalfW * 2}
                  height={PLOT_H + BOTTOM_PAD}
                  fill="transparent"
                />

                <line
                  className="bb-trend-hit-guide"
                  x1={x}
                  y1={TOP_PAD}
                  x2={x}
                  y2={TOP_PAD + PLOT_H}
                  stroke="rgba(11, 61, 36, 0.25)"
                  strokeDasharray="3 3"
                  strokeWidth="1.2"
                />

                {!hasData && (
                  <line
                    x1={x}
                    y1={TOP_PAD + PLOT_H - 6}
                    x2={x}
                    y2={TOP_PAD + PLOT_H + 3}
                    stroke="#cbd5e1"
                    strokeWidth="1.5"
                  />
                )}

                {hasData && (
                  <>
                    {visibleSeries.survey && (
                      <circle
                        cx={x}
                        cy={yForPct(wk.surveys.response_rate_pct)}
                        r="3.5"
                        fill="#ffffff"
                        stroke="#d97706"
                        strokeWidth="2"
                      />
                    )}
                    {visibleSeries.meas && (
                      <circle
                        cx={x}
                        cy={yForPct(wk.measurements.coverage_pct)}
                        r="3.5"
                        fill="#ffffff"
                        stroke="#1d5786"
                        strokeWidth="2"
                      />
                    )}
                    {visibleSeries.fill && (
                      <circle
                        cx={x}
                        cy={yForPct(wk.attendance.fill_pct)}
                        r="4"
                        fill="#1f9d55"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                      />
                    )}
                  </>
                )}

                <text
                  x={x}
                  y={labelY}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight={hasData ? 600 : 400}
                  fill={hasData ? '#1a1e1b' : '#9ca3af'}
                >
                  W{wk.week_number}
                </text>
                <text
                  x={x}
                  y={labelY + 13}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="#9ca3af"
                >
                  {hasData ? `${wk.submitted_session_count}s` : 'Pending'}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
