'use client';

import { useState, useMemo } from 'react';
import type { ProgramWeekData } from '@/lib/programData';
import { formatDate } from '@/lib/format';
import {
  WEEK_STATE_META,
  SESSION_STATE_META,
  getWeekColor,
} from '@/lib/timelineRules';

type Props = {
  weeks: ProgramWeekData[];
  hasNutritionist: boolean;
  today: string;
};

export default function WeeksOfProgramSection({ weeks, hasNutritionist }: Props) {
  const defaultIndex = useMemo(() => {
    if (weeks.length === 0) return 0;
    const currentIdx = weeks.findIndex((w) => w.state === 'current');
    if (currentIdx !== -1) return currentIdx;

    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].has_submitted_data) return i;
    }
    return 0;
  }, [weeks]);

  const [selectedIndex, setSelectedIndex] = useState<number>(defaultIndex);

  if (weeks.length === 0) {
    return (
      <div className="card bb-card mb-4 overflow-hidden">
        <div className="card-body p-5 text-center text-body-secondary">
          No program weeks generated for this program.
        </div>
      </div>
    );
  }

  const safeIndex = Math.min(Math.max(0, selectedIndex), weeks.length - 1);
  const selectedWeek = weeks[safeIndex];
  const weekTheme = getWeekColor(selectedWeek.week_number);
  const weekStateMeta = WEEK_STATE_META[selectedWeek.state];

  const handlePrev = () => setSelectedIndex((prev) => Math.max(0, prev - 1));
  const handleNext = () => setSelectedIndex((prev) => Math.min(weeks.length - 1, prev + 1));

  return (
    <div className="card bb-card mb-4 overflow-hidden">
      {/* Header with Week Stepper Controls */}
      <div className="card-header bg-white border-bottom p-3 p-md-4">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-3">
          <div>
            <div className="d-flex align-items-center gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark">Weeks of the Program</h2>
              <span className="badge rounded-pill badge-pale-neutral small bb-num">
                Week {selectedWeek.week_number} of {weeks.length}
              </span>
            </div>
            <p className="text-body-secondary small mb-0">
              Weekly Sunday–Saturday attendance, measurement completeness, and survey outcomes (submitted sessions on or after registration).
            </p>
          </div>

          <div className="d-flex align-items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary rounded-circle d-inline-flex align-items-center justify-content-center p-0"
              style={{ width: '36px', height: '36px' }}
              onClick={handlePrev}
              disabled={safeIndex === 0}
              aria-label="Previous program week"
              title="Previous week"
            >
              ‹
            </button>
            <span className="small text-body-secondary fw-semibold px-1 bb-num">
              {safeIndex + 1} / {weeks.length}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary rounded-circle d-inline-flex align-items-center justify-content-center p-0"
              style={{ width: '36px', height: '36px' }}
              onClick={handleNext}
              disabled={safeIndex === weeks.length - 1}
              aria-label="Next program week"
              title="Next week"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="card-body p-3 p-md-4">
        {/* Horizontal Visual Week Selector Stepper */}
        <div className="overflow-x-auto pb-2 mb-4">
          <div
            className="bb-stepper-track mx-auto"
            style={{ minWidth: `${Math.max(weeks.length * 125, 480)}px`, maxWidth: '960px' }}
          >
            <div className="bb-stepper-line" />
            {weeks.map((wk, idx) => {
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
                  onClick={() => setSelectedIndex(idx)}
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
                    <span
                      className={`badge rounded-pill mt-1 ${stateMeta.badgeClass}`}
                      style={{ fontSize: '0.67rem' }}
                    >
                      {wk.sessions.length} session{wk.sessions.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Week Banner & Member Sessions */}
        <div
          className="bb-shell mb-4"
          style={{ borderLeft: `4px solid ${weekTheme.hex}` }}
        >
          <div className="bb-shell-inner">
            <div className="d-flex flex-wrap justify-content-between align-items-start gap-3">
              <div>
                <div className="d-flex flex-wrap align-items-center gap-2 mb-1">
                  <span className={`badge rounded-pill ${weekTheme.badgeClass}`}>
                    Week {selectedWeek.week_number}
                  </span>
                  <span className={`badge rounded-pill ${weekStateMeta.badgeClass}`}>
                    {weekStateMeta.label}
                  </span>
                  <span className="small text-body-secondary bb-num">
                    {formatDate(selectedWeek.week_start_date)} – {formatDate(selectedWeek.week_end_date)}
                  </span>
                </div>
                <div className="d-flex flex-wrap gap-2 mt-2">
                  {selectedWeek.sessions.length === 0 ? (
                    <span className="small text-body-secondary">No sessions scheduled this week.</span>
                  ) : (
                    selectedWeek.sessions.map((s) => {
                      const sm = SESSION_STATE_META[s.state];
                      return (
                        <span
                          key={s.session_id}
                          className="badge bg-white border text-dark d-inline-flex align-items-center gap-1 fw-normal px-2 py-1"
                        >
                          <span className={`rounded-circle d-inline-block ${sm.dotClass}`} style={{ width: 7, height: 7 }} />
                          <span className="bb-num fw-semibold">{formatDate(s.session_date)}</span>
                          <span className="text-body-secondary">({sm.label})</span>
                        </span>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="text-md-end">
                <div className="small text-body-secondary">Submitted sessions</div>
                <div className="fw-bold fs-5 bb-num text-dark">
                  {selectedWeek.submitted_session_count} / {selectedWeek.sessions.length}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Metrics Section */}
        {!selectedWeek.has_submitted_data ? (
          <div className="alert alert-light border text-body-secondary small mb-0 text-center py-4">
            No submitted sessions in Week {selectedWeek.week_number} yet. Weekly attendance, measurement completeness, and survey outcomes compute from submitted sessions only.
          </div>
        ) : (
          <div className="row g-3">
            {/* Group 1: Attendance */}
            <div className="col-12 col-xl-4">
              <div className="bb-surface-tile p-3 h-100 d-flex flex-column">
                <div className="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom">
                  <h3 className="h6 fw-bold mb-0 text-dark">Attendance</h3>
                  <span className="badge rounded-pill badge-pale-info bb-num">
                    {selectedWeek.attendance.reach_eligible} eligible
                  </span>
                </div>

                <div className="row g-2 mb-3">
                  <div className="col-6">
                    <div className="p-2 rounded bg-white border h-100">
                      <div className="small text-body-secondary">Reach (≥1 day)</div>
                      <div className="fs-5 fw-bold bb-num text-primary">
                        {selectedWeek.attendance.reach_pct}%
                      </div>
                      <div className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                        {selectedWeek.attendance.reach_attended} / {selectedWeek.attendance.reach_eligible} enrollees
                      </div>
                    </div>
                  </div>
                  <div className="col-6">
                    <div className="p-2 rounded bg-white border h-100">
                      <div className="small text-body-secondary">Slot Fill Rate</div>
                      <div className="fs-5 fw-bold bb-num text-dark">
                        {selectedWeek.attendance.fill_pct}%
                      </div>
                      <div className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                        {selectedWeek.attendance.fill_check_ins} / {selectedWeek.attendance.fill_eligible_slots} slots
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mb-3">
                  <div className="small fw-semibold text-body-secondary mb-2">Weekly Consistency</div>
                  <div className="row g-1 text-center">
                    <div className="col-3">
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-success">{selectedWeek.attendance.consistency.all_days}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.7rem' }}>All days</div>
                      </div>
                    </div>
                    <div className="col-3">
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-info">{selectedWeek.attendance.consistency.two_to_three_days}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.7rem' }}>2–3 days</div>
                      </div>
                    </div>
                    <div className="col-3">
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-warning">{selectedWeek.attendance.consistency.one_day}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.7rem' }}>1 day</div>
                      </div>
                    </div>
                    <div className="col-3">
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-secondary">{selectedWeek.attendance.consistency.zero_days}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.7rem' }}>0 days</div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Best & Lowest Days + Per-Day Breakdown */}
                <div className="mt-auto">
                  {selectedWeek.attendance.best_day && (
                    <div className="d-flex flex-wrap gap-2 mb-2">
                      <span className="badge badge-pale-success bb-num fw-normal">
                        Best: {formatDate(selectedWeek.attendance.best_day.session_date)} ({selectedWeek.attendance.best_day.pct}%)
                      </span>
                      {selectedWeek.attendance.lowest_day && selectedWeek.attendance.per_day.length > 1 && (
                        <span className="badge badge-pale-warning bb-num fw-normal">
                          Lowest: {formatDate(selectedWeek.attendance.lowest_day.session_date)} ({selectedWeek.attendance.lowest_day.pct}%)
                        </span>
                      )}
                    </div>
                  )}

                  <div className="table-responsive">
                    <table className="table table-sm mb-0 small bg-white rounded border">
                      <thead className="table-light">
                        <tr>
                          <th>Session</th>
                          <th className="text-end">Present</th>
                          <th className="text-end">Fill</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedWeek.attendance.per_day.map((day) => (
                          <tr key={day.session_id}>
                            <td className="bb-num">{formatDate(day.session_date)}</td>
                            <td className="text-end bb-num">
                              {day.present_count}/{day.eligible_count}
                            </td>
                            <td className="text-end bb-num fw-semibold">{day.pct}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            {/* Group 2: Measurements */}
            <div className="col-12 col-xl-4">
              <div className="bb-surface-tile p-3 h-100 d-flex flex-column">
                <div className="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom">
                  <h3 className="h6 fw-bold mb-0 text-dark">Measurements</h3>
                  {selectedWeek.measurements.zero_measurement_sessions_count > 0 ? (
                    <span className="badge rounded-pill badge-pale-danger bb-num">
                      {selectedWeek.measurements.zero_measurement_sessions_count} zero-meas session
                      {selectedWeek.measurements.zero_measurement_sessions_count === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="badge rounded-pill badge-pale-success bb-num">
                      0 zero-meas sessions
                    </span>
                  )}
                </div>

                <div className="p-2 rounded bg-white border mb-3">
                  <div className="d-flex justify-content-between align-items-baseline">
                    <span className="small text-body-secondary">Unique coverage (among attendees)</span>
                    <span className="fs-5 fw-bold bb-num text-primary">
                      {selectedWeek.measurements.coverage_pct}%
                    </span>
                  </div>
                  <div className="progress my-1" style={{ height: '6px' }}>
                    <div
                      className="progress-bar bg-primary"
                      style={{ width: `${selectedWeek.measurements.coverage_pct}%` }}
                    />
                  </div>
                  <div className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                    {selectedWeek.measurements.unique_measured_count} of {selectedWeek.measurements.unique_present_count} attendees had ≥1 measurement
                  </div>
                </div>

                <div className="mb-3">
                  <div className="small fw-semibold text-body-secondary mb-2">
                    Missing Among Attendees
                  </div>
                  <div className="row g-1 text-center">
                    <div className={hasNutritionist ? 'col-3' : 'col-6'}>
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-dark">{selectedWeek.measurements.missing_weight_count}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>Weight</div>
                      </div>
                    </div>
                    <div className={hasNutritionist ? 'col-3' : 'col-6'}>
                      <div className="p-2 rounded bg-white border">
                        <div className="fw-bold bb-num text-dark">{selectedWeek.measurements.missing_waist_count}</div>
                        <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>Waist</div>
                      </div>
                    </div>
                    {hasNutritionist && (
                      <>
                        <div className="col-3">
                          <div className="p-2 rounded bg-white border">
                            <div className="fw-bold bb-num text-dark">{selectedWeek.measurements.missing_muac_count}</div>
                            <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>MUAC</div>
                          </div>
                        </div>
                        <div className="col-3">
                          <div className="p-2 rounded bg-white border">
                            <div className="fw-bold bb-num text-dark">{selectedWeek.measurements.missing_edema_count}</div>
                            <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>Edema</div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-auto">
                  <div className="small fw-semibold text-body-secondary mb-1">Per Session Day</div>
                  <div className="table-responsive">
                    <table className="table table-sm mb-0 small bg-white rounded border">
                      <thead className="table-light">
                        <tr>
                          <th>Date</th>
                          <th className="text-end">Meas</th>
                          <th className="text-end">Wt</th>
                          <th className="text-end">Wst</th>
                          {hasNutritionist && <th className="text-end">M/E</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {selectedWeek.measurements.per_day.map((d) => (
                          <tr key={d.session_id}>
                            <td className="bb-num">
                              {formatDate(d.session_date)}
                              {d.zero_measurements && (
                                <span className="badge badge-pale-danger ms-1" style={{ fontSize: '0.65rem' }}>
                                  0
                                </span>
                              )}
                            </td>
                            <td className="text-end bb-num fw-semibold">
                              {d.measured_count}/{d.present_count}
                            </td>
                            <td className="text-end bb-num">{d.weight_count}</td>
                            <td className="text-end bb-num">{d.waist_count}</td>
                            {hasNutritionist && (
                              <td className="text-end bb-num">
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
            </div>

            {/* Group 3: Surveys */}
            <div className="col-12 col-xl-4">
              <div className="bb-surface-tile p-3 h-100 d-flex flex-column">
                <div className="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom">
                  <h3 className="h6 fw-bold mb-0 text-dark">Surveys (1–5 Scale)</h3>
                  <span className="badge rounded-pill badge-pale-neutral bb-num">
                    {selectedWeek.surveys.response_rate_pct}% response
                  </span>
                </div>

                <div className="p-2 rounded bg-white border mb-3">
                  <div className="d-flex justify-content-between align-items-baseline">
                    <span className="small text-body-secondary">Unique Respondents</span>
                    <span className="fs-5 fw-bold bb-num text-dark">
                      {selectedWeek.surveys.respondent_count} / {selectedWeek.surveys.attendee_count}
                    </span>
                  </div>
                  <div className="text-body-secondary" style={{ fontSize: '0.75rem' }}>
                    Unique attendees submitting ≥1 survey rating this week
                  </div>
                </div>

                {selectedWeek.surveys.lowest_category && (
                  <div className="p-2 rounded bg-white border border-warning-subtle mb-3">
                    <div className="d-flex justify-content-between align-items-center">
                      <span className="small fw-semibold text-dark">
                        Lowest category: {selectedWeek.surveys.lowest_category.label}
                      </span>
                      <span className="bb-num fw-bold text-dark">
                        {selectedWeek.surveys.lowest_category.avg?.toFixed(2)} / 5
                      </span>
                    </div>
                    <div className="small text-body-secondary bb-num mt-1">
                      {selectedWeek.surveys.lowest_category.delta == null ? (
                        'No prior week score for comparison'
                      ) : selectedWeek.surveys.lowest_category.delta > 0 ? (
                        <span className="text-success">
                          +{selectedWeek.surveys.lowest_category.delta.toFixed(2)} vs last week
                        </span>
                      ) : selectedWeek.surveys.lowest_category.delta < 0 ? (
                        <span className="text-danger">
                          {selectedWeek.surveys.lowest_category.delta.toFixed(2)} vs last week
                        </span>
                      ) : (
                        <span>0.00 vs last week (unchanged)</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="mt-auto">
                  <div className="small fw-semibold text-body-secondary mb-2">Pooled Category Averages</div>
                  <div className="d-flex flex-column gap-2">
                    {selectedWeek.surveys.categories.map((cat) => {
                      const pctWidth = cat.avg != null ? Math.min(100, Math.round((cat.avg / 5) * 100)) : 0;
                      return (
                        <div key={cat.question_id} className="p-2 rounded bg-white border">
                          <div className="d-flex justify-content-between align-items-center small mb-1">
                            <span className="fw-semibold text-dark">{cat.label}</span>
                            <span className="bb-num">
                              {cat.avg != null ? (
                                <>
                                  <strong>{cat.avg.toFixed(2)}</strong>
                                  <span className="text-body-secondary ms-1">(n={cat.n})</span>
                                  {cat.delta != null && (
                                    <span
                                      className={`ms-2 ${
                                        cat.delta > 0
                                          ? 'text-success'
                                          : cat.delta < 0
                                          ? 'text-danger'
                                          : 'text-body-secondary'
                                      }`}
                                    >
                                      {cat.delta > 0 ? `+${cat.delta.toFixed(2)}` : cat.delta.toFixed(2)}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-body-secondary">No responses (n=0)</span>
                              )}
                            </span>
                          </div>
                          <div className="progress" style={{ height: '5px' }}>
                            <div className="progress-bar bg-info" style={{ width: `${pctWidth}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
