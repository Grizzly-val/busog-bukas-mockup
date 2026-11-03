'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import type {
  SessionData,
  TimelineData,
  BeneficiaryData,
  AvailableAllergy,
  AssignedNutritionist,
  SurveyQuestion,
} from '@/lib/programData';
import { SESSION_STATE_META, getTimelineColor } from '@/lib/timelineRules';
import LargeSessionCard from './LargeSessionCard';

type Props = {
  sessions: SessionData[];
  timelines: TimelineData[];
  startDate: string;
  endDate: string;
  today: string;
  initialSessionId?: string;
  programId: string;
  beneficiaries: BeneficiaryData[];
  availableAllergies: AvailableAllergy[];
  assignedNutritionists: AssignedNutritionist[];
  surveyQuestions: SurveyQuestion[];
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function SessionCalendar({
  sessions,
  timelines,
  startDate,
  endDate,
  today,
  initialSessionId,
  programId,
  beneficiaries,
  availableAllergies,
  assignedNutritionists,
  surveyQuestions,
}: Props) {
  // Generate list of 'YYYY-MM' months covering the program dates
  const availableMonths = useMemo(() => {
    const months: string[] = [];
    const [startYear, startMonth] = startDate.slice(0, 7).split('-').map(Number);
    const [endYear, endMonth] = endDate.slice(0, 7).split('-').map(Number);

    let curYear = startYear;
    let curMonth = startMonth;

    while (curYear < endYear || (curYear === endYear && curMonth <= endMonth)) {
      const mStr = String(curMonth).padStart(2, '0');
      months.push(`${curYear}-${mStr}`);
      curMonth++;
      if (curMonth > 12) {
        curMonth = 1;
        curYear++;
      }
    }
    return months;
  }, [startDate, endDate]);

  const defaultMonth = useMemo(() => {
    if (initialSessionId) {
      const match = sessions.find((s) => s.session_id === initialSessionId);
      if (match) return match.session_date.slice(0, 7);
    }
    const todayMonth = today.slice(0, 7);
    if (availableMonths.includes(todayMonth)) return todayMonth;
    return availableMonths[0] ?? startDate.slice(0, 7);
  }, [initialSessionId, sessions, today, availableMonths, startDate]);

  const [selectedMonth, setSelectedMonth] = useState<string>(defaultMonth);

  // Modal session overlay state ("FB Post" pop-up UX)
  const [modalSessionId, setModalSessionId] = useState<string | null>(() => {
    if (initialSessionId && sessions.some((s) => s.session_id === initialSessionId)) {
      return initialSessionId;
    }
    return null;
  });

  const openSessionModal = (session: SessionData) => {
    setModalSessionId(session.session_id);
    setSelectedMonth(session.session_date.slice(0, 7));
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('sessionId', session.session_id);
      window.history.replaceState({}, '', url.toString());
    }
  };

  const closeSessionModal = useCallback(() => {
    setModalSessionId(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('sessionId');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  // Listen for browser popstate or escape
  useEffect(() => {
    const handlePopState = () => {
      const sp = new URLSearchParams(window.location.search);
      const sId = sp.get('sessionId');
      if (sId && sessions.some((s) => s.session_id === sId)) {
        setModalSessionId(sId);
      } else {
        setModalSessionId(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [sessions]);

  const activeModalSession = useMemo(
    () => sessions.find((s) => s.session_id === modalSessionId) ?? null,
    [sessions, modalSessionId]
  );

  // Month grid calculations
  const [year, monthNum] = selectedMonth.split('-').map(Number);
  const firstDayOfWeek = new Date(Date.UTC(year, monthNum - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();

  const sessionsByDate = useMemo(() => {
    const map = new Map<string, SessionData>();
    for (const s of sessions) {
      map.set(s.session_date, s);
    }
    return map;
  }, [sessions]);

  const boundaryDatesMap = useMemo(() => {
    const map = new Map<string, { endsSeq: number; startsSeq: number }>();
    for (let i = 0; i < timelines.length; i++) {
      const cur = timelines[i];
      const next = timelines[i + 1];
      if (next && cur.end_date === next.start_date) {
        map.set(cur.end_date, { endsSeq: cur.seq, startsSeq: next.seq });
      }
    }
    return map;
  }, [timelines]);

  const getTimelinesForDate = (dateStr: string) => {
    return timelines.filter((t) => dateStr >= t.start_date && dateStr <= t.end_date);
  };

  return (
    <>
      {/* Month Calendar Card */}
      <div className="card bb-card mb-4 overflow-hidden shadow-sm">
        <div className="card-header bg-white border-bottom p-3 p-md-4">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-3">
            <div>
              <h2 className="h5 fw-bold mb-1 text-dark">Session Calendar</h2>
              <p className="text-body-secondary small mb-2">
                Click any session to view its live statistics, records, and data inputs in an overlay modal.
              </p>
              {timelines.length > 0 && (
                <div className="d-flex flex-wrap align-items-center gap-2 mt-1">
                  <span className="text-body-secondary small fw-medium" style={{ fontSize: '0.72rem' }}>
                    Timelines:
                  </span>
                  {timelines.map((tl) => {
                    const theme = getTimelineColor(tl.seq);
                    return (
                      <span
                        key={tl.timeline_id}
                        className="badge rounded-pill d-inline-flex align-items-center gap-1 px-2 py-1"
                        style={{
                          backgroundColor: theme.bgSoft,
                          color: theme.hex,
                          border: `1px solid ${theme.borderSoft}`,
                          fontSize: '0.68rem',
                        }}
                      >
                        <span
                          className="rounded-circle d-inline-block"
                          style={{ width: '7px', height: '7px', backgroundColor: theme.hex }}
                        />
                        Timeline {tl.seq}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Month Switcher Navigation */}
            <div className="d-flex align-items-center gap-1 flex-wrap">
              {availableMonths.map((m) => {
                const [, mn] = m.split('-').map(Number);
                const [y] = m.split('-').map(Number);
                const label = `${MONTH_NAMES[mn - 1].slice(0, 3)} ${y}`;
                const isSelected = m === selectedMonth;
                const hasToday = m === today.slice(0, 7);

                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSelectedMonth(m)}
                    className={`btn btn-sm rounded-pill px-3 py-1 ${
                      isSelected
                        ? 'btn-dark fw-semibold shadow-sm'
                        : 'btn-outline-secondary'
                    }`}
                  >
                    {label}
                    {hasToday && (
                      <span
                        className={`badge rounded-pill ms-1 ${
                          isSelected ? 'bg-success text-white' : 'badge-pale-success'
                        }`}
                        style={{ fontSize: '0.62rem' }}
                      >
                        Today
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="card-body p-3 p-md-4">
          {/* Calendar Grid */}
          <div className="table-responsive">
            <table className="table table-bordered mb-0 align-middle text-center" style={{ tableLayout: 'fixed' }}>
              <thead className="table-light">
                <tr>
                  {DAY_NAMES.map((day) => (
                    <th
                      key={day}
                      className="text-center py-2 text-uppercase text-body-secondary fw-semibold"
                      style={{ width: '14.28%', fontSize: '0.72rem', letterSpacing: '0.05em' }}
                    >
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalSlots = Math.ceil((firstDayOfWeek + daysInMonth) / 7) * 7;
                  const rows = [];
                  let cells = [];

                  for (let slot = 0; slot < totalSlots; slot++) {
                    const dayNumber = slot - firstDayOfWeek + 1;
                    const isCurrentMonthDay = dayNumber >= 1 && dayNumber <= daysInMonth;

                    if (!isCurrentMonthDay) {
                      cells.push(
                        <td key={slot} className="bg-light-subtle text-muted p-1" style={{ height: '88px', opacity: 0.25 }}>
                          &nbsp;
                        </td>
                      );
                    } else {
                      const dateStr = `${selectedMonth}-${String(dayNumber).padStart(2, '0')}`;
                      const inProgramRange = dateStr >= startDate && dateStr <= endDate;
                      const session = sessionsByDate.get(dateStr);
                      const coveringTimelines = getTimelinesForDate(dateStr);
                      const boundaryInfo = boundaryDatesMap.get(dateStr);
                      const isToday = dateStr === today;
                      const isModalActive = session && session.session_id === modalSessionId;

                      const primaryTl = coveringTimelines[0];
                      const owningSeq = session?.owning_seq ?? (boundaryInfo ? boundaryInfo.endsSeq : primaryTl?.seq);
                      const tlTheme = owningSeq ? getTimelineColor(owningSeq) : (primaryTl ? getTimelineColor(primaryTl.seq) : null);

                      let cellBg = '#ffffff';
                      let cellBorder = '1px solid rgba(0, 0, 0, 0.06)';

                      if (primaryTl && inProgramRange) {
                        cellBg = tlTheme?.bgSoft ?? '#f8faf8';
                        cellBorder = `1px solid ${tlTheme?.borderSoft ?? 'rgba(0, 0, 0, 0.08)'}`;
                      }

                      if (isModalActive) {
                        cellBorder = `2px solid ${tlTheme?.hex ?? '#198754'}`;
                      } else if (session) {
                        if (session.state === 'submitted') {
                          cellBorder = `1.5px solid ${tlTheme?.borderSoft ?? 'rgba(25, 135, 84, 0.35)'}`;
                        } else if (session.state === 'draft') {
                          cellBorder = '1.5px solid rgba(245, 158, 11, 0.75)';
                        } else if (session.state === 'skipped') {
                          cellBorder = '1px solid rgba(108, 117, 125, 0.35)';
                        } else if (session.state === 'upcoming') {
                          cellBorder = `1.5px dashed ${tlTheme?.borderSoft ?? 'rgba(0, 0, 0, 0.25)'}`;
                        }
                      }

                      cells.push(
                        <td
                          key={slot}
                          className={`p-2 position-relative ${session ? 'user-select-none' : ''}`}
                          style={{
                            height: '88px',
                            verticalAlign: 'top',
                            backgroundColor: cellBg,
                            border: cellBorder,
                            transition: 'all 0.15s ease',
                            cursor: session ? 'pointer' : 'default',
                          }}
                          onClick={() => session && openSessionModal(session)}
                          title={session ? `Click to view Session on ${dateStr}` : undefined}
                        >
                          <div className="d-flex justify-content-between align-items-center mb-1">
                            <span
                              className={`badge rounded-circle d-inline-flex align-items-center justify-content-center bb-num ${
                                isToday
                                  ? 'bg-success text-white shadow-sm'
                                  : 'text-dark fw-semibold'
                              }`}
                              style={{ width: '22px', height: '22px', fontSize: '0.78rem' }}
                              title={isToday ? 'Mock Today' : undefined}
                            >
                              {dayNumber}
                            </span>

                            {boundaryInfo ? (
                              <span
                                className="badge rounded-pill text-white shadow-sm"
                                style={{
                                  fontSize: '0.62rem',
                                  padding: '0.2rem 0.45rem',
                                  backgroundColor: tlTheme?.hex ?? '#212529',
                                }}
                                title={`Boundary handover: Closes T${boundaryInfo.endsSeq}, Starts T${boundaryInfo.startsSeq}`}
                              >
                                T{boundaryInfo.endsSeq} ⇄ T{boundaryInfo.startsSeq}
                              </span>
                            ) : coveringTimelines.length > 0 && inProgramRange ? (
                              <span
                                className="badge rounded-pill shadow-sm"
                                style={{
                                  fontSize: '0.62rem',
                                  backgroundColor: tlTheme?.hex ?? '#6c757d',
                                  color: '#fff',
                                  padding: '0.2rem 0.45rem',
                                }}
                                title={`Timeline ${owningSeq ?? primaryTl.seq}`}
                              >
                                T{owningSeq ?? primaryTl.seq}
                              </span>
                            ) : null}
                          </div>

                          {session ? (
                            <div className="d-flex flex-column gap-1 text-start mt-1">
                              {session.state === 'submitted' && (
                                <span
                                  className="badge rounded-pill bg-success text-white fw-semibold shadow-sm text-truncate"
                                  style={{ fontSize: '0.68rem', padding: '0.22rem 0.45rem' }}
                                >
                                  ✓ Submitted
                                </span>
                              )}
                              {session.state === 'draft' && (
                                <span
                                  className="badge rounded-pill bg-warning text-dark fw-bold border border-warning-subtle shadow-sm text-truncate"
                                  style={{ fontSize: '0.68rem', padding: '0.22rem 0.45rem' }}
                                >
                                  Draft
                                </span>
                              )}
                              {session.state === 'upcoming' && (
                                <span
                                  className="badge rounded-pill bg-white text-secondary border border-secondary-subtle text-truncate shadow-sm"
                                  style={{ fontSize: '0.68rem', padding: '0.22rem 0.45rem' }}
                                >
                                  Upcoming
                                </span>
                              )}
                              {session.state === 'skipped' && (
                                <span
                                  className="badge rounded-pill bg-secondary text-white opacity-75 text-truncate"
                                  style={{ fontSize: '0.68rem', padding: '0.22rem 0.45rem' }}
                                >
                                  Skipped
                                </span>
                              )}

                              {session.notes.length > 0 && (
                                <span
                                  className="text-body-secondary small text-truncate"
                                  style={{ fontSize: '0.65rem' }}
                                >
                                  📝 {session.notes.length} note{session.notes.length > 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                          ) : inProgramRange ? (
                            <span className="text-muted small d-block mt-2" style={{ fontSize: '0.65rem', opacity: 0.5 }}>
                              —
                            </span>
                          ) : null}
                        </td>
                      );
                    }

                    if (cells.length === 7) {
                      rows.push(<tr key={rows.length}>{cells}</tr>);
                      cells = [];
                    }
                  }
                  return rows;
                })()}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal Overlay for Active Session ("FB Post" Pop-up UX) */}
      {activeModalSession && (
        <LargeSessionCard
          session={activeModalSession}
          programId={programId}
          beneficiaries={beneficiaries}
          availableAllergies={availableAllergies}
          assignedNutritionists={assignedNutritionists}
          surveyQuestions={surveyQuestions}
          timelines={timelines}
          today={today}
          onClose={closeSessionModal}
        />
      )}
    </>
  );
}
