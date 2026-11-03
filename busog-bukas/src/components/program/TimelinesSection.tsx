'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BeneficiaryData, TimelineData } from '@/lib/programData';
import { formatDate, daysBetween } from '@/lib/format';
import {
  TIMELINE_STATE_META,
  SESSION_STATE_META,
  getTimelineColor,
  isSessionOwnedByTimeline,
} from '@/lib/timelineRules';
import {
  summarizeTimeline,
  hasTimelineMeasurement,
  classifyStatus,
  computeStatusTransitions,
  computeConcernKeyDistribution,
  STATUS_LABEL,
  STATUS_BADGE_CLASS,
  type StatusKey,
  type ReasonKey,
  type StatusTransitionCategory,
} from '@/lib/statusRule';

type Props = {
  timelines: TimelineData[];
  beneficiaries?: BeneficiaryData[];
  today: string;
};

type ActiveAnalyticsModal = 'transitions' | 'concerns' | null;

const TRANSITION_CATEGORY_META: Record<
  StatusTransitionCategory,
  { label: string; badgeClass: string }
> = {
  improved: { label: 'Improved', badgeClass: 'badge-pale-success' },
  declined: { label: 'Declined', badgeClass: 'badge-pale-danger' },
  coverage_shift: { label: 'Coverage Shift', badgeClass: 'badge-pale-warning' },
  unchanged: { label: 'Unchanged', badgeClass: 'badge-pale-neutral text-muted' },
};

export default function TimelinesSection({ timelines, beneficiaries = [] }: Props) {
  const defaultIndex = useMemo(() => {
    if (timelines.length === 0) return 0;
    const openIdx = timelines.findIndex((t) => t.state === 'open');
    if (openIdx !== -1) return openIdx;

    for (let i = timelines.length - 1; i >= 0; i--) {
      if (timelines[i].state === 'closed') return i;
    }
    return 0;
  }, [timelines]);

  const [selectedIndex, setSelectedIndex] = useState<number>(defaultIndex);
  const [activeModal, setActiveModal] = useState<ActiveAnalyticsModal>(null);
  const [mounted, setMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!activeModal) return;

    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusTimer = setTimeout(() => {
      modalRef.current?.focus();
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveModal(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow === 'hidden' ? '' : prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeModal]);

  // Precompute per-Timeline beneficiary status summaries
  const timelineSummariesBySeq = useMemo(() => {
    const map = new Map<
      number,
      {
        timeline: TimelineData;
        eligibleCodes: string[];
        statusByCode: Map<string, StatusKey>;
        statusRows: Array<{ beneficiary_code: string; status_key: StatusKey; status_reason: ReasonKey }>;
      }
    >();

    for (const tl of timelines) {
      const eligibleCodes: string[] = [];
      const tlEnd = tl.end_date.slice(0, 10);

      const dbStatusMap = new Map<string, { status_key: StatusKey; status_reason: ReasonKey }>();
      if (tl.beneficiary_statuses && tl.beneficiary_statuses.length > 0) {
        for (const row of tl.beneficiary_statuses) {
          dbStatusMap.set(row.beneficiary_code, {
            status_key: row.status_key,
            status_reason: row.status_reason,
          });
        }
      }

      const statusByCode = new Map<string, StatusKey>();
      const statusRows: Array<{ beneficiary_code: string; status_key: StatusKey; status_reason: ReasonKey }> = [];

      for (const b of beneficiaries) {
        const regDate = b.registered_session_date.slice(0, 10);
        if (regDate > tlEnd) continue;

        eligibleCodes.push(b.beneficiary_code);

        const attributedMeasurements = b.measurements
          .filter(
            (m) =>
              isSessionOwnedByTimeline(m.session_date, tl.seq, tl.start_date, tl.end_date) &&
              (tl.closed_at == null || m.submitted_at != null)
          )
          .map((m) => ({
            session_date: m.session_date,
            is_present: m.is_present,
            weight_kg: m.weight_kg,
            height_cm: m.height_cm,
            waist_cm: m.waist_cm,
            muac_cm: m.muac_cm,
            edema: m.edema,
          }));

        const metrics = summarizeTimeline(attributedMeasurements);
        const isMeasured = hasTimelineMeasurement(metrics);

        const fromDb = dbStatusMap.get(b.beneficiary_code);
        if (fromDb) {
          statusByCode.set(b.beneficiary_code, fromDb.status_key);
          statusRows.push({
            beneficiary_code: b.beneficiary_code,
            status_key: fromDb.status_key,
            status_reason: fromDb.status_reason,
          });
        } else if (isMeasured) {
          const classified = classifyStatus({
            sex: b.sex,
            birthMonth: b.birth_month,
            birthYear: b.birth_year,
            asOf: tlEnd,
            bmi: metrics.bmi,
            whtr: metrics.whtr,
            muacCm: metrics.muacCm,
            edema: metrics.edema,
            hasPartialMeasurement: isMeasured,
          });
          if (classified) {
            statusByCode.set(b.beneficiary_code, classified.statusKey);
            statusRows.push({
              beneficiary_code: b.beneficiary_code,
              status_key: classified.statusKey,
              status_reason: classified.reasonKey,
            });
          }
        }
      }

      if (statusRows.length === 0 && tl.beneficiary_statuses && tl.beneficiary_statuses.length > 0) {
        for (const row of tl.beneficiary_statuses) {
          statusByCode.set(row.beneficiary_code, row.status_key);
          statusRows.push(row);
        }
      }

      map.set(tl.seq, {
        timeline: tl,
        eligibleCodes,
        statusByCode,
        statusRows,
      });
    }

    return map;
  }, [timelines, beneficiaries]);

  if (timelines.length === 0) {
    return (
      <div className="card bb-card mb-4 overflow-hidden">
        <div className="card-body p-5 text-center text-body-secondary">
          No timelines generated for this program.
        </div>
      </div>
    );
  }

  const safeIndex = Math.min(Math.max(0, selectedIndex), timelines.length - 1);
  const selectedTl = timelines[safeIndex];
  const selectedTheme = getTimelineColor(selectedTl.seq);
  const selectedStateMeta = TIMELINE_STATE_META[selectedTl.state];
  const spanDays = daysBetween(selectedTl.start_date, selectedTl.end_date);

  const currSummary = timelineSummariesBySeq.get(selectedTl.seq);
  const prevImmediateSummary =
    selectedTl.seq > 1 ? timelineSummariesBySeq.get(selectedTl.seq - 1) : undefined;

  const statusTransitions = useMemo(() => {
    if (selectedTl.state !== 'closed' || selectedTl.seq <= 1 || !currSummary || !prevImmediateSummary) {
      return null;
    }
    return computeStatusTransitions(
      currSummary.eligibleCodes,
      prevImmediateSummary.statusByCode,
      currSummary.statusByCode
    );
  }, [selectedTl.state, selectedTl.seq, currSummary, prevImmediateSummary]);

  const concernDistribution = useMemo(() => {
    if (selectedTl.state !== 'closed' || !currSummary) {
      return null;
    }
    return computeConcernKeyDistribution(
      currSummary.statusRows,
      selectedTl.registered_count,
      selectedTl.measured_count
    );
  }, [selectedTl.state, selectedTl.registered_count, selectedTl.measured_count, currSummary]);

  const handlePrev = () => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setSelectedIndex((prev) => Math.min(timelines.length - 1, prev + 1));
  };

  // Concise trigger button subtitles
  const transitionsTriggerSubtitle =
    selectedTl.seq === 1
      ? 'Baseline cycle (starts in Timeline 2)'
      : selectedTl.state === 'closed' && statusTransitions
      ? `T${selectedTl.seq - 1} to T${selectedTl.seq}: ${statusTransitions.improvedTotal} improved, ${statusTransitions.declinedTotal} declined`
      : 'Evaluated when cycle closes';

  const concernsTriggerSubtitle =
    selectedTl.state === 'closed' && concernDistribution
      ? `${concernDistribution.totalFlaggedCount} flagged (${concernDistribution.normalCount} baseline)`
      : 'Evaluated when cycle closes';

  return (
    <div className="card bb-card mb-4 overflow-hidden">
      {/* Card Header with Stepper Controls */}
      <div className="card-header bg-white border-bottom p-3 p-md-4">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-3">
          <div>
            <div className="d-flex align-items-center gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark">Timelines &amp; Coverage</h2>
              <span className="badge rounded-pill badge-pale-neutral small bb-num">
                Cycle {safeIndex + 1} of {timelines.length}
              </span>
            </div>
            <p className="text-body-secondary small mb-0">
              14-day monitoring cycles, attributed measurement coverage, and cohort outcomes.
            </p>
          </div>

          <div className="d-flex align-items-center gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary rounded-circle d-inline-flex align-items-center justify-content-center p-0"
              style={{ width: '36px', height: '36px' }}
              onClick={handlePrev}
              disabled={safeIndex === 0}
              aria-label="Previous timeline cycle"
              title="Previous cycle"
            >
              ‹
            </button>
            <span className="small text-body-secondary fw-semibold px-1 bb-num">
              {safeIndex + 1} / {timelines.length}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary rounded-circle d-inline-flex align-items-center justify-content-center p-0"
              style={{ width: '36px', height: '36px' }}
              onClick={handleNext}
              disabled={safeIndex === timelines.length - 1}
              aria-label="Next timeline cycle"
              title="Next cycle"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="card-body p-3 p-md-4">
        {/* Horizontal Visual Node Stepper Track */}
        <div className="overflow-x-auto pb-2 mb-4">
          <div
            className="bb-stepper-track mx-auto"
            style={{ minWidth: `${Math.max(timelines.length * 130, 480)}px`, maxWidth: '900px' }}
          >
            <div className="bb-stepper-line" />

            {timelines.map((tl, idx) => {
              const isSelected = idx === safeIndex;
              const isClosed = tl.state === 'closed';
              const isOpen = tl.state === 'open';
              const stateMeta = TIMELINE_STATE_META[tl.state];

              let nodeStateClass = 'state-upcoming';
              if (isClosed) nodeStateClass = 'state-closed';
              else if (isOpen) nodeStateClass = 'state-open';

              return (
                <button
                  key={tl.timeline_id}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  className={`bb-node-wrapper ${isSelected ? 'is-selected' : ''}`}
                  aria-pressed={isSelected}
                  aria-label={`Timeline ${tl.seq} (${stateMeta.label})`}
                >
                  <div className={`bb-node-circle ${nodeStateClass}`}>
                    {isClosed ? '✓' : `T${tl.seq}`}
                  </div>
                  <div className="bb-node-meta">
                    <div className="bb-node-title">Timeline {tl.seq}</div>
                    <div className="bb-node-date bb-num">
                      {formatDate(tl.start_date)} - {formatDate(tl.end_date)}
                    </div>
                    <span
                      className={`badge rounded-pill mt-1 ${
                        isOpen
                          ? 'badge-pale-success'
                          : isClosed
                          ? 'badge-pale-neutral'
                          : 'badge-pale-neutral text-muted'
                      }`}
                      style={{ fontSize: '0.62rem', padding: '0.15rem 0.45rem' }}
                    >
                      {isOpen ? 'Active' : isClosed ? 'Closed' : 'Upcoming'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Focused Timeline Detail Surface */}
        <div className="bb-shell">
          <div className="bb-shell-inner p-3 p-md-4">
            {/* Timeline Header Row */}
            <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 border-bottom pb-3 mb-4">
              <div>
                <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
                  <span
                    className="badge rounded-pill fw-bold"
                    style={{
                      backgroundColor: selectedTheme.hex,
                      color: '#ffffff',
                      fontSize: '0.78rem',
                      padding: '0.32rem 0.72rem',
                    }}
                  >
                    Timeline {selectedTl.seq}
                  </span>
                  <span className={`badge rounded-pill ${selectedStateMeta.badgeClass}`} style={{ fontSize: '0.78rem' }}>
                    {selectedStateMeta.label}
                  </span>
                  {selectedTl.closed_at && (
                    <span className="text-body-secondary small bb-num">
                      Closed {formatDate(selectedTl.closed_at)}
                    </span>
                  )}
                </div>
                <h3 className="h5 fw-bold mb-0 text-dark bb-num">
                  {formatDate(selectedTl.start_date)} - {formatDate(selectedTl.end_date)}
                  <span className="fw-normal text-body-secondary small ms-2">
                    ({spanDays} days)
                  </span>
                </h3>
              </div>

              <div className="text-md-end">
                <span className="badge rounded-pill badge-pale-neutral small">
                  {selectedTl.seq === 1 ? 'Owns start & end dates' : 'Owns sessions after start date'}
                </span>
              </div>
            </div>

            {/* High-Level Essentials Grid (4 Core Blocks) */}
            <div className="row g-3 mb-4">
              {/* 1. Measurement Coverage */}
              <div className="col-12 col-lg-6">
                <div className="bb-surface-tile h-100 d-flex flex-column justify-content-between">
                  <div>
                    <div className="d-flex justify-content-between align-items-baseline mb-2">
                      <span className="fw-semibold text-dark small">Measurement Coverage</span>
                      <span className="fw-bold text-dark bb-num">
                        {selectedTl.measured_count} / {selectedTl.registered_count}{' '}
                        <span className="text-body-secondary fw-normal">({selectedTl.coverage_pct}%)</span>
                      </span>
                    </div>

                    <div className="progress bb-progress mb-2" style={{ height: '6px' }}>
                      <div
                        className={`progress-bar ${
                          selectedTl.coverage_pct >= 80
                            ? 'bg-success'
                            : selectedTl.coverage_pct >= 50
                            ? 'bg-warning'
                            : 'bg-primary'
                        }`}
                        style={{ width: `${selectedTl.coverage_pct}%` }}
                      />
                    </div>
                  </div>

                  <p className="text-body-secondary small mb-0" style={{ fontSize: '0.76rem' }}>
                    {selectedTl.coverage_pct >= 80
                      ? 'High cohort coverage achieved for outcome evaluation.'
                      : selectedTl.coverage_pct >= 50
                      ? 'Moderate coverage; follow up with remaining beneficiaries.'
                      : 'Cycle in progress; measurements are actively being logged.'}
                  </p>
                </div>
              </div>

              {/* 2. Attributed Member Sessions */}
              <div className="col-12 col-lg-6">
                <div className="bb-surface-tile h-100">
                  <div className="d-flex justify-content-between align-items-baseline mb-2">
                    <span className="fw-semibold text-dark small">Attributed Member Sessions</span>
                    <span className="text-body-secondary small bb-num">
                      {selectedTl.member_sessions.length} session{selectedTl.member_sessions.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  {selectedTl.member_sessions.length === 0 ? (
                    <span className="small text-muted">No sessions attributed to this cycle yet.</span>
                  ) : (
                    <div className="d-flex flex-wrap gap-2">
                      {selectedTl.member_sessions.map((ms) => (
                        <span
                          key={ms.session_id}
                          className={`badge rounded-pill ${SESSION_STATE_META[ms.state].badgeClass} bb-num`}
                          style={{ fontSize: '0.74rem', padding: '0.35rem 0.65rem' }}
                        >
                          {formatDate(ms.session_date)}
                          {ms.boundary.isBoundary && ' (Boundary)'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 3. Cohort Outcome Status Breakdown (Top-Level Summary Counters Only) */}
              <div className="col-12 col-lg-6">
                <div className="bb-surface-tile h-100 d-flex flex-column justify-content-between">
                  <div className="d-flex justify-content-between align-items-baseline mb-2">
                    <span className="fw-semibold text-dark small">Cohort Outcome Status Breakdown</span>
                    {selectedTl.state === 'closed' && (
                      <span className="text-body-secondary small bb-num" style={{ fontSize: '0.74rem' }}>
                        {selectedTl.measured_count} evaluated
                      </span>
                    )}
                  </div>

                  {selectedTl.state === 'closed' && selectedTl.status_counts ? (
                    <div className="row g-2">
                      <div className="col-6 col-sm-3">
                        <div className="bg-white rounded-3 p-2 text-center border h-100">
                          <span className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                            Baseline
                          </span>
                          <span className="fw-bold fs-5 text-success bb-num">
                            {selectedTl.status_counts.baseline}
                          </span>
                        </div>
                      </div>
                      <div className="col-6 col-sm-3">
                        <div className="bg-white rounded-3 p-2 text-center border h-100">
                          <span className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                            Monitor
                          </span>
                          <span className="fw-bold fs-5 text-warning bb-num">
                            {selectedTl.status_counts.monitor}
                          </span>
                        </div>
                      </div>
                      <div className="col-6 col-sm-3">
                        <div className="bg-white rounded-3 p-2 text-center border h-100">
                          <span className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                            Monitor Closely
                          </span>
                          <span className="fw-bold fs-5 text-danger bb-num">
                            {selectedTl.status_counts.monitor_closely}
                          </span>
                        </div>
                      </div>
                      <div className="col-6 col-sm-3">
                        <div
                          className="bg-white rounded-3 p-2 text-center border h-100"
                          title="Incomplete measurement data (missing paired height or weight)"
                        >
                          <span className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                            Unavailable
                          </span>
                          <span className="fw-bold fs-5 text-secondary bb-num">
                            {selectedTl.status_counts.unavailable ?? 0}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="small text-body-secondary mb-0">
                      {selectedTl.state === 'open'
                        ? 'Cycle in progress. Outcome statuses are computed automatically when the closing session is submitted.'
                        : 'Upcoming cycle. Status evaluation has not started.'}
                    </p>
                  )}
                </div>
              </div>

              {/* 4. AI Longitudinal Trend Analysis */}
              <div className="col-12 col-lg-6">
                <div className="bb-surface-tile h-100 d-flex flex-column justify-content-between">
                  <div>
                    <div className="d-flex justify-content-between align-items-baseline mb-2">
                      <span className="fw-semibold text-dark small">AI Longitudinal Trend Analysis</span>
                      {selectedTl.ai_interpretation && (
                        <span className="text-body-secondary small bb-num" style={{ fontSize: '0.72rem' }}>
                          {formatDate(selectedTl.ai_interpretation.created_at)}
                        </span>
                      )}
                    </div>

                    {selectedTl.ai_interpretation ? (
                      <p className="small mb-0 text-dark" style={{ lineHeight: 1.55 }}>
                        &ldquo;{selectedTl.ai_interpretation.comments}&rdquo;
                      </p>
                    ) : (
                      <p className="small mb-0 text-body-secondary">
                        Longitudinal trend synthesis is generated automatically when the closing session of this cycle is submitted.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Deep-Dive Analytics Action Bar (2 On-Demand Overlay Triggers) */}
            <div className="pt-3 border-top">
              <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                <span className="small fw-semibold text-body-secondary">
                  Deep-Dive Cohort Analytics
                </span>
                <span className="text-body-secondary" style={{ fontSize: '0.74rem' }}>
                  Select a report to inspect detailed status transitions or concern triggers
                </span>
              </div>

              <div className="row g-3">
                {/* Trigger 1: Status Transitions */}
                <div className="col-12 col-md-6">
                  <button
                    type="button"
                    className="bb-analytics-trigger h-100"
                    onClick={() => setActiveModal('transitions')}
                  >
                    <div>
                      <div className="fw-semibold text-dark small mb-1">
                        Status Transitions
                      </div>
                      <div className="text-body-secondary bb-num" style={{ fontSize: '0.76rem' }}>
                        {transitionsTriggerSubtitle}
                      </div>
                    </div>
                    <span className="bb-trigger-arrow" aria-hidden="true">
                      &#8599;
                    </span>
                  </button>
                </div>

                {/* Trigger 2: Nutritional Concern & Trigger Key Distribution */}
                <div className="col-12 col-md-6">
                  <button
                    type="button"
                    className="bb-analytics-trigger h-100"
                    onClick={() => setActiveModal('concerns')}
                  >
                    <div>
                      <div className="fw-semibold text-dark small mb-1">
                        Nutritional Concern Triggers
                      </div>
                      <div className="text-body-secondary bb-num" style={{ fontSize: '0.76rem' }}>
                        {concernsTriggerSubtitle}
                      </div>
                    </div>
                    <span className="bb-trigger-arrow" aria-hidden="true">
                      &#8599;
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* On-Demand Analytics Modal Overlay (Portaled to body)                */}
      {/* ------------------------------------------------------------------- */}
      {mounted &&
        activeModal &&
        createPortal(
          <div
            ref={modalRef}
            className="bb-modal-overlay"
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="timelineAnalyticsModalTitle"
            onClick={() => setActiveModal(null)}
          >
            <div
              className="bb-modal-dialog"
              style={{ maxWidth: '980px' }}
              role="document"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header with View Switcher */}
              <div className="p-3 p-md-4 border-bottom d-flex flex-wrap justify-content-between align-items-center gap-3 bg-white sticky-top">
                <div>
                  <div className="d-flex align-items-center gap-2 mb-1">
                    <span
                      className="badge rounded-pill fw-bold"
                      style={{
                        backgroundColor: selectedTheme.hex,
                        color: '#ffffff',
                        fontSize: '0.72rem',
                      }}
                    >
                      Timeline {selectedTl.seq}
                    </span>
                    <span className="text-body-secondary small bb-num">
                      {formatDate(selectedTl.start_date)} - {formatDate(selectedTl.end_date)}
                    </span>
                  </div>
                  <h3 id="timelineAnalyticsModalTitle" className="h5 fw-bold mb-0 text-dark">
                    {activeModal === 'transitions' && 'Status Transitions from Previous Timeline'}
                    {activeModal === 'concerns' && 'Nutritional Concern & Trigger Key Distribution'}
                  </h3>
                </div>

                <div className="d-flex align-items-center gap-2 flex-wrap">
                  {/* Segmented View Switcher */}
                  <div className="bg-light p-1 rounded-pill border d-inline-flex gap-1">
                    <button
                      type="button"
                      className={`btn btn-sm rounded-pill px-3 py-1 ${
                        activeModal === 'transitions' ? 'btn-dark fw-semibold' : 'btn-light text-secondary border-0'
                      }`}
                      style={{ fontSize: '0.75rem' }}
                      onClick={() => setActiveModal('transitions')}
                    >
                      Transitions
                    </button>
                    <button
                      type="button"
                      className={`btn btn-sm rounded-pill px-3 py-1 ${
                        activeModal === 'concerns' ? 'btn-dark fw-semibold' : 'btn-light text-secondary border-0'
                      }`}
                      style={{ fontSize: '0.75rem' }}
                      onClick={() => setActiveModal('concerns')}
                    >
                      Concern Keys
                    </button>
                  </div>

                  <button
                    type="button"
                    className="btn-close ms-1"
                    aria-label="Close analytics overlay"
                    onClick={() => setActiveModal(null)}
                  />
                </div>
              </div>

              {/* Modal Body */}
              <div className="p-3 p-md-4 bg-white">
                {/* ========================================================= */}
                {/* VIEW 1: Status Transitions (T_{seq-1} -> T_{seq})         */}
                {/* ========================================================= */}
                {activeModal === 'transitions' && (
                  <div>
                    {selectedTl.seq === 1 ? (
                      <div className="bb-surface-tile text-center py-5">
                        <div className="fw-semibold text-dark mb-1">Baseline Cycle (Timeline 1)</div>
                        <p className="text-body-secondary small mb-0 mx-auto" style={{ maxWidth: '50ch' }}>
                          Initial baseline cycle - status transitions from a previous timeline begin in Timeline 2.
                        </p>
                      </div>
                    ) : selectedTl.state !== 'closed' || !statusTransitions ? (
                      <div className="bb-surface-tile text-center py-5">
                        <div className="fw-semibold text-dark mb-1">Cycle Not Yet Closed</div>
                        <p className="text-body-secondary small mb-0 mx-auto" style={{ maxWidth: '52ch' }}>
                          Status transitions between Timeline {selectedTl.seq - 1} and Timeline {selectedTl.seq} will be evaluated once the closing session of this cycle is submitted.
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* Key Takeaway KPI Strip */}
                        <div className="row g-3 mb-4">
                          <div className="col-6 col-md-3">
                            <div className="bb-surface-tile text-center h-100">
                              <span className="text-body-secondary small d-block mb-1">Improved</span>
                              <span className="fs-3 fw-bold text-success bb-num">
                                {statusTransitions.improvedTotal}
                              </span>
                              <span className="text-body-secondary d-block" style={{ fontSize: '0.72rem' }}>
                                Lower severity tier
                              </span>
                            </div>
                          </div>
                          <div className="col-6 col-md-3">
                            <div className="bb-surface-tile text-center h-100">
                              <span className="text-body-secondary small d-block mb-1">Declined</span>
                              <span className="fs-3 fw-bold text-danger bb-num">
                                {statusTransitions.declinedTotal}
                              </span>
                              <span className="text-body-secondary d-block" style={{ fontSize: '0.72rem' }}>
                                Higher severity tier
                              </span>
                            </div>
                          </div>
                          <div className="col-6 col-md-3">
                            <div className="bb-surface-tile text-center h-100">
                              <span className="text-body-secondary small d-block mb-1">Coverage Shift</span>
                              <span className="fs-3 fw-bold text-warning bb-num">
                                {statusTransitions.coverageShiftTotal}
                              </span>
                              <span className="text-body-secondary d-block" style={{ fontSize: '0.72rem' }}>
                                Entered or left coverage
                              </span>
                            </div>
                          </div>
                          <div className="col-6 col-md-3">
                            <div className="bb-surface-tile text-center h-100">
                              <span className="text-body-secondary small d-block mb-1">Unchanged</span>
                              <span className="fs-3 fw-bold text-secondary bb-num">
                                {statusTransitions.unchangedTotal}
                              </span>
                              <span className="text-body-secondary d-block" style={{ fontSize: '0.72rem' }}>
                                Same tier as T{selectedTl.seq - 1}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Scannable Non-Zero Transitions Table */}
                        <div className="bb-shell">
                          <div className="bb-shell-inner p-3">
                            <div className="d-flex justify-content-between align-items-center mb-2 px-1">
                              <span className="fw-semibold text-dark small">
                                Non-Zero Status Movements (Timeline {selectedTl.seq - 1} &rarr; Timeline {selectedTl.seq})
                              </span>
                              <span className="text-body-secondary small bb-num">
                                {statusTransitions.cohortTotal} eligible beneficiaries
                              </span>
                            </div>

                            <div className="table-responsive">
                              <table className="table table-sm table-borderless align-middle mb-0">
                                <thead>
                                  <tr className="border-bottom text-body-secondary small">
                                    <th scope="col" className="py-2 ps-2">
                                      From (T{selectedTl.seq - 1}) &rarr; To (T{selectedTl.seq})
                                    </th>
                                    <th scope="col" className="py-2">
                                      Shift Type
                                    </th>
                                    <th scope="col" className="py-2 text-end">
                                      Beneficiaries
                                    </th>
                                    <th scope="col" className="py-2 pe-2 text-end">
                                      Share of Cohort
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {statusTransitions.rows.map((tr) => {
                                    const catMeta = TRANSITION_CATEGORY_META[tr.category];
                                    return (
                                      <tr
                                        key={`${tr.fromStatus}_${tr.toStatus}`}
                                        className="bb-hairline-row"
                                      >
                                        <td className="py-2 ps-2">
                                          <div className="d-inline-flex align-items-center gap-2 flex-wrap">
                                            <span
                                              className={`badge rounded-pill ${STATUS_BADGE_CLASS[tr.fromStatus]}`}
                                              style={{ fontSize: '0.74rem' }}
                                            >
                                              {STATUS_LABEL[tr.fromStatus]}
                                            </span>
                                            <span className="text-body-secondary small">&rarr;</span>
                                            <span
                                              className={`badge rounded-pill ${STATUS_BADGE_CLASS[tr.toStatus]}`}
                                              style={{ fontSize: '0.74rem' }}
                                            >
                                              {STATUS_LABEL[tr.toStatus]}
                                            </span>
                                          </div>
                                        </td>
                                        <td className="py-2">
                                          <span
                                            className={`badge rounded-pill ${catMeta.badgeClass}`}
                                            style={{ fontSize: '0.72rem' }}
                                          >
                                            {catMeta.label}
                                          </span>
                                        </td>
                                        <td className="py-2 text-end fw-bold text-dark bb-num">
                                          {tr.count}
                                        </td>
                                        <td className="py-2 pe-2 text-end text-body-secondary bb-num">
                                          {tr.pctOfCohort}%
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ========================================================= */}
                {/* VIEW 2: Nutritional Concern & Trigger Key Distribution    */}
                {/* ========================================================= */}
                {activeModal === 'concerns' && (
                  <div>
                    {selectedTl.state !== 'closed' || !concernDistribution ? (
                      <div className="bb-surface-tile text-center py-5">
                        <div className="fw-semibold text-dark mb-1">Cycle Not Yet Closed</div>
                        <p className="text-body-secondary small mb-0 mx-auto" style={{ maxWidth: '52ch' }}>
                          Nutritional concern trigger keys (bmi, muac, whtr, edema) are evaluated and stored upon submitting the closing session of Timeline {selectedTl.seq}.
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* Cohort Context Summary Strip */}
                        <div className="row g-3 mb-4">
                          <div className="col-12 col-md-4">
                            <div className="bb-surface-tile h-100 d-flex justify-content-between align-items-center">
                              <div>
                                <span className="text-body-secondary small d-block">
                                  Flagged Concerns (Monitor + Closely)
                                </span>
                                <span className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                  Driven by bmi, muac, whtr, or edema
                                </span>
                              </div>
                              <span className="fs-3 fw-bold text-danger bb-num">
                                {concernDistribution.totalFlaggedCount}
                              </span>
                            </div>
                          </div>

                          <div className="col-12 col-md-4">
                            <div className="bb-surface-tile h-100 d-flex justify-content-between align-items-center">
                              <div>
                                <span className="text-body-secondary small d-block">
                                  Healthy Thresholds (key: normal)
                                </span>
                                <span className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                                  {concernDistribution.normalPctOfMeasured}% of measured cohort
                                </span>
                              </div>
                              <span className="fs-3 fw-bold text-success bb-num">
                                {concernDistribution.normalCount}
                              </span>
                            </div>
                          </div>

                          <div className="col-12 col-md-4">
                            <div className="bb-surface-tile h-100 d-flex justify-content-between align-items-center">
                              <div>
                                <span className="text-body-secondary small d-block">
                                  Incomplete / Unmeasured
                                </span>
                                <span className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                                  {concernDistribution.incompleteMeasuredCount} key: incomplete_data, {concernDistribution.unmeasuredCount} unmeasured
                                </span>
                              </div>
                              <span className="fs-3 fw-bold text-secondary bb-num">
                                {concernDistribution.totalUnavailableOrUnmeasured}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* 2x2 Grid of Clinical Concern Triggers */}
                        <div className="row g-3">
                          {concernDistribution.items.map((item) => {
                            const hasCases = item.totalFlagged > 0;
                            const monitorShareWidth =
                              concernDistribution.measuredCount > 0
                                ? Math.round((item.monitorCount / concernDistribution.measuredCount) * 100)
                                : 0;
                            const closelyShareWidth =
                              concernDistribution.measuredCount > 0
                                ? Math.round((item.closelyCount / concernDistribution.measuredCount) * 100)
                                : 0;

                            return (
                              <div key={item.reasonKey} className="col-12 col-md-6">
                                <div className="bb-metric-card h-100 d-flex flex-column justify-content-between">
                                  <div>
                                    <div className="d-flex justify-content-between align-items-start gap-2 mb-2">
                                      <div>
                                        <span className="fw-bold text-dark d-block">
                                          {item.title}
                                        </span>
                                        <span className="text-body-secondary small" style={{ fontSize: '0.75rem' }}>
                                          {item.description}
                                        </span>
                                      </div>
                                      <span
                                        className="badge rounded-pill badge-pale-neutral font-monospace"
                                        style={{ fontSize: '0.72rem' }}
                                      >
                                        key: {item.reasonKey}
                                      </span>
                                    </div>

                                    <div className="d-flex align-items-baseline justify-content-between my-3">
                                      <div>
                                        <span className="fs-3 fw-bold text-dark bb-num me-2">
                                          {item.totalFlagged}
                                        </span>
                                        <span className="text-body-secondary small bb-num">
                                          flagged ({item.pctOfFlagged}% of flagged, {item.pctOfMeasured}% of measured)
                                        </span>
                                      </div>
                                    </div>
                                  </div>

                                  <div>
                                    <div className="progress bb-progress mb-2" style={{ height: '6px' }}>
                                      {hasCases ? (
                                        <>
                                          <div
                                            className="progress-bar bg-warning"
                                            style={{ width: `${Math.max(monitorShareWidth, item.monitorCount > 0 ? 4 : 0)}%` }}
                                          />
                                          <div
                                            className="progress-bar bg-danger"
                                            style={{ width: `${Math.max(closelyShareWidth, item.closelyCount > 0 ? 4 : 0)}%` }}
                                          />
                                        </>
                                      ) : (
                                        <div className="progress-bar bg-secondary-subtle" style={{ width: '0%' }} />
                                      )}
                                    </div>

                                    <div className="d-flex justify-content-between align-items-center small">
                                      <span className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                                        <strong className="text-warning-emphasis">{item.monitorCount}</strong> Monitor
                                      </span>
                                      <span className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
                                        <strong className="text-danger">{item.closelyCount}</strong> Monitor closely
                                      </span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
