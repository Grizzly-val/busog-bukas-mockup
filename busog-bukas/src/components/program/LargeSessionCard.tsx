'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type {
  SessionData,
  BeneficiaryData,
  AvailableAllergy,
  AssignedNutritionist,
  SurveyQuestion,
  TimelineData,
  SessionRecordSummary,
} from '@/lib/programData';
import { formatDate } from '@/lib/format';
import { ageInMonths } from '@/lib/statusRule';
import { SESSION_STATE_META } from '@/lib/timelineRules';
import {
  registerBeneficiaryAction,
  saveDefaultInputAction,
  saveNutritionistInputAction,
  submitSessionAction,
} from '@/app/actions';

type Props = {
  session: SessionData;
  programId: string;
  beneficiaries: BeneficiaryData[];
  availableAllergies: AvailableAllergy[];
  assignedNutritionists: AssignedNutritionist[];
  surveyQuestions: SurveyQuestion[];
  timelines: TimelineData[];
  today: string;
  onClose?: () => void;
};

export default function LargeSessionCard({
  session,
  programId,
  beneficiaries,
  availableAllergies,
  assignedNutritionists,
  surveyQuestions,
  timelines,
  today,
  onClose,
}: Props) {
  // Nested sub-modal state for data-entry forms ('default' | 'register' | 'nutritionist' | null)
  const [openNestedForm, setOpenNestedForm] = useState<'default' | 'register' | 'nutritionist' | null>(null);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'danger'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [expandedNoteCode, setExpandedNoteCode] = useState<string | null>(null);

  const isLocked = session.state === 'submitted' || session.state === 'skipped';
  const hasNutritionists = assignedNutritionists.length > 0;
  const isUpcoming =
    session.state === 'upcoming' ||
    (session.submitted_at == null && session.records.length === 0 && session.session_date > today);

  // Check if session ends an open timeline
  const closingTimeline = timelines.find((t) => t.end_session_id === session.session_id && t.state === 'open');

  // Registered beneficiaries as of this session date
  const registeredBeneficiaries = beneficiaries.filter((b) => b.registered_session_date <= session.session_date);

  // Check if any record in this session has nutritionist data or if program has nutritionists assigned
  const hasNutritionistData =
    hasNutritionists ||
    session.records.some((r) => r.muac_cm != null || r.edema != null || Boolean(r.clinical_notes));

  // -------------------------------------------------------------------------
  // Form State: Default Input (Measurements & Check-in)
  // -------------------------------------------------------------------------
  const [defaultBenCode, setDefaultBenCode] = useState<string>(
    registeredBeneficiaries[0]?.beneficiary_code ?? ''
  );
  const [defaultPresent, setDefaultPresent] = useState<boolean>(true);
  const [defaultWeight, setDefaultWeight] = useState<string>('');
  const [defaultHeight, setDefaultHeight] = useState<string>('');
  const [defaultWaist, setDefaultWaist] = useState<string>('');
  const [surveyVals, setSurveyVals] = useState<Record<string, number>>({
    q_portion: 4,
    q_service: 5,
    q_taste: 4,
    q_satisfaction: 4,
  });

  // Duplicate measurement check for Default Input
  let duplicateNotice: { date: string; seq: number } | null = null;
  if (defaultBenCode && session.owning_seq) {
    const targetBen = beneficiaries.find((b) => b.beneficiary_code === defaultBenCode);
    const owningTl = timelines.find((t) => t.seq === session.owning_seq);
    if (targetBen && owningTl) {
      for (const m of targetBen.measurements) {
        if (m.session_id !== session.session_id && (m.weight_kg != null || m.height_cm != null)) {
          if (
            (owningTl.seq === 1 && m.session_date >= owningTl.start_date && m.session_date <= owningTl.end_date) ||
            (owningTl.seq > 1 && m.session_date > owningTl.start_date && m.session_date <= owningTl.end_date)
          ) {
            duplicateNotice = { date: m.session_date, seq: owningTl.seq };
            break;
          }
        }
      }
    }
  }

  // Load existing session record into Default Input form for editing
  const handleEditRecord = (record: SessionRecordSummary) => {
    if (isLocked) return;
    setDefaultBenCode(record.beneficiary_code);
    setDefaultPresent(record.is_present);
    setDefaultWeight(record.weight_kg != null ? String(record.weight_kg) : '');
    setDefaultHeight(record.height_cm != null ? String(record.height_cm) : '');
    setDefaultWaist(record.waist_cm != null ? String(record.waist_cm) : '');
    if (record.survey_answers && Object.keys(record.survey_answers).length > 0) {
      setSurveyVals((prev) => ({ ...prev, ...record.survey_answers }));
    }
    setOpenNestedForm('default');
  };

  const handleOpenAddDefault = () => {
    if (isLocked) return;
    // Reset to first registered beneficiary or clear
    if (registeredBeneficiaries[0]) {
      setDefaultBenCode(registeredBeneficiaries[0].beneficiary_code);
    }
    setDefaultPresent(true);
    setDefaultWeight('');
    setDefaultHeight('');
    setDefaultWaist('');
    setSurveyVals({
      q_portion: 4,
      q_service: 5,
      q_taste: 4,
      q_satisfaction: 4,
    });
    setOpenNestedForm('default');
  };

  const handleSaveDefaultInput = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked) return;
    setActionMessage(null);

    startTransition(async () => {
      const res = await saveDefaultInputAction({
        programId,
        sessionId: session.session_id,
        beneficiaryCode: defaultBenCode,
        isPresent: defaultPresent,
        weightKg: defaultWeight ? parseFloat(defaultWeight) : null,
        heightCm: defaultHeight ? parseFloat(defaultHeight) : null,
        waistCm: defaultWaist ? parseFloat(defaultWaist) : null,
        surveyAnswers: surveyVals,
      });

      if (res.success) {
        setActionMessage({ type: 'success', text: `Saved record for beneficiary #${defaultBenCode} successfully.` });
        setOpenNestedForm(null);
      } else {
        setActionMessage({ type: 'danger', text: res.error || 'Failed to save default input.' });
      }
    });
  };

  // -------------------------------------------------------------------------
  // Form State: Register Beneficiary
  // -------------------------------------------------------------------------
  const [regBirthMonth, setRegBirthMonth] = useState<number>(1);
  const [regBirthYear, setRegBirthYear] = useState<number>(2018);
  const [regSex, setRegSex] = useState<'female' | 'male'>('female');
  const [regName, setRegName] = useState<string>('');
  const [regSelectedAllergies, setRegSelectedAllergies] = useState<string[]>([]);
  const [regGuardianName, setRegGuardianName] = useState<string>('');
  const [regGuardianNumber, setRegGuardianNumber] = useState<string>('');
  const [regGuardianRel, setRegGuardianRel] = useState<string>('mother');

  const regMonths = ageInMonths(regBirthMonth, regBirthYear, session.session_date);
  const regIsMinor = regMonths < 216; // < 18 years
  const requiresGuardian = regIsMinor && Boolean(regName.trim());

  const handleRegisterBeneficiary = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked) return;
    setActionMessage(null);

    if (requiresGuardian) {
      if (!regGuardianName.trim() || !regGuardianNumber.trim() || !regGuardianRel.trim()) {
        setActionMessage({
          type: 'danger',
          text: 'Guardian name, contact number, and relationship are strictly required for minors when storing a full name.',
        });
        return;
      }
    }

    startTransition(async () => {
      const res = await registerBeneficiaryAction({
        programId,
        sessionId: session.session_id,
        birthMonth: Number(regBirthMonth),
        birthYear: Number(regBirthYear),
        sex: regSex,
        name: regName.trim() || null,
        allergies: regSelectedAllergies,
        guardian:
          regIsMinor && regGuardianName.trim() && regGuardianNumber.trim()
            ? {
                name: regGuardianName.trim(),
                number: regGuardianNumber.trim(),
                relationship: regGuardianRel.trim(),
              }
            : null,
      });

      if (res.success && res.beneficiaryCode) {
        setActionMessage({
          type: 'success',
          text: `Beneficiary #${res.beneficiaryCode} registered! Assigned: ${res.displayName}. Check-in record created.`,
        });
        setRegName('');
        setRegGuardianName('');
        setRegGuardianNumber('');
        setRegSelectedAllergies([]);
        setDefaultBenCode(res.beneficiaryCode);
        setOpenNestedForm(null);
      } else {
        setActionMessage({ type: 'danger', text: res.error || 'Failed to register beneficiary.' });
      }
    });
  };

  // -------------------------------------------------------------------------
  // Form State: Nutritionist Input
  // -------------------------------------------------------------------------
  const [nutriBenCode, setNutriBenCode] = useState<string>(
    registeredBeneficiaries[0]?.beneficiary_code ?? ''
  );
  const [nutriId, setNutriId] = useState<string>(assignedNutritionists[0]?.nutritionist_id ?? '');
  const [nutriMuac, setNutriMuac] = useState<string>('');
  const [nutriEdema, setNutriEdema] = useState<boolean>(false);
  const [nutriNotes, setNutriNotes] = useState<string>('');

  const handleSaveNutritionist = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked || !hasNutritionists) return;
    setActionMessage(null);

    startTransition(async () => {
      const res = await saveNutritionistInputAction({
        programId,
        sessionId: session.session_id,
        beneficiaryCode: nutriBenCode,
        nutritionistId: nutriId,
        muacCm: nutriMuac ? parseFloat(nutriMuac) : null,
        edema: nutriEdema,
        clinicalNotes: nutriNotes,
      });

      if (res.success) {
        setActionMessage({ type: 'success', text: `Nutritionist check saved for beneficiary #${nutriBenCode}.` });
        setNutriMuac('');
        setNutriNotes('');
        setOpenNestedForm(null);
      } else {
        setActionMessage({ type: 'danger', text: res.error || 'Failed to save nutritionist record.' });
      }
    });
  };

  // -------------------------------------------------------------------------
  // Submit Session Handler
  // -------------------------------------------------------------------------
  const handleConfirmSubmit = () => {
    if (isLocked) return;
    setShowSubmitModal(false);
    setActionMessage(null);

    startTransition(async () => {
      const res = await submitSessionAction(session.session_id, programId);
      if (res.success) {
        setActionMessage({
          type: 'success',
          text: res.message || 'Session submitted and reconciled successfully.',
        });
      } else {
        setActionMessage({
          type: 'danger',
          text: res.error || 'Failed to submit session.',
        });
      }
    });
  };

  const [mounted, setMounted] = useState(false);
  const modalContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Body scroll lock effect & initial focus management
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const timer = setTimeout(() => {
      modalContainerRef.current?.focus();
    }, 20);

    return () => {
      clearTimeout(timer);
      document.body.style.overflow = originalOverflow === 'hidden' ? '' : originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
    };
  }, []);

  // Keyboard escape listener
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (openNestedForm) {
          setOpenNestedForm(null);
        } else if (showSubmitModal) {
          setShowSubmitModal(false);
        } else if (onClose) {
          onClose();
        }
      }
    },
    [openNestedForm, showSubmitModal, onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const attendancePct =
    session.aggregates.registered_count > 0
      ? Math.round((session.aggregates.present_count / session.aggregates.registered_count) * 100)
      : 0;

  if (!mounted) return null;

  return createPortal(
    <div
      ref={modalContainerRef}
      className="bb-modal-overlay"
      tabIndex={-1}
      style={{ outline: 'none' }}
      onClick={() => {
        if (!openNestedForm && !showSubmitModal && onClose) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bb-modal-dialog bb-scrollable"
        onClick={(e) => e.stopPropagation()}
        id="largeSessionCard"
      >
        {/* ----------------------------------------------------------------- */}
        {/* Sticky Top Header                                                 */}
        {/* ----------------------------------------------------------------- */}
        <div className="p-3 p-md-4 border-bottom bg-white d-flex flex-wrap justify-content-between align-items-center gap-3 sticky-top">
          <div>
            <div className="d-flex align-items-center gap-2 mb-1 flex-wrap">
              <span className="small text-body-secondary fw-semibold text-uppercase tracking-wider">
                Active Session
              </span>
              <span className={`badge rounded-pill ${SESSION_STATE_META[session.state].badgeClass}`}>
                {SESSION_STATE_META[session.state].label}
              </span>
              {session.boundary.isBoundary && (
                <span className="badge rounded-pill bg-dark text-white">
                  Boundary: T{session.boundary.endsSeq} ⇄ T{session.boundary.startsSeq}
                </span>
              )}
              {session.owning_seq && (
                <span className="badge rounded-pill badge-pale-info">
                  Timeline {session.owning_seq} Attribution
                </span>
              )}
            </div>
            <h2 className="h4 fw-bold mb-0 text-dark">
              Session on {formatDate(session.session_date)}
            </h2>
          </div>

          <div className="d-flex align-items-center gap-2">
            {/* Submit Session Button */}
            {session.state === 'submitted' ? (
              <span className="badge badge-pale-success py-2 px-3 small fw-semibold">
                ✓ Submitted {formatDate(session.submitted_at)}
              </span>
            ) : session.state === 'skipped' ? (
              <span className="badge badge-pale-neutral py-2 px-3 small fw-semibold">
                🔒 Skipped &amp; Locked
              </span>
            ) : isUpcoming ? (
              <span className="badge badge-pale-neutral py-2 px-3 small text-muted">
                Upcoming Session
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-sm btn-success rounded-pill px-3 py-1 fw-semibold shadow-sm"
                onClick={() => setShowSubmitModal(true)}
                disabled={isPending}
              >
                {isPending ? 'Submitting...' : '✓ Submit Session'}
              </button>
            )}

            {/* Modal Close Button */}
            {onClose && (
              <button
                type="button"
                className="btn btn-light rounded-circle p-2 d-inline-flex align-items-center justify-content-center text-body-secondary"
                style={{ width: '36px', height: '36px' }}
                onClick={onClose}
                aria-label="Close session view"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Scrollable Modal Body                                             */}
        {/* ----------------------------------------------------------------- */}
        <div className="p-3 p-md-4">
          {/* Action Message Alert */}
          {actionMessage && (
            <div
              className={`alert alert-${actionMessage.type} alert-dismissible fade show border-0 rounded-4 p-3 mb-4`}
              role="alert"
            >
              {actionMessage.type === 'success' ? '✓ ' : '⚠️ '}
              {actionMessage.text}
              <button
                type="button"
                className="btn-close"
                aria-label="Close"
                onClick={() => setActionMessage(null)}
              />
            </div>
          )}

          {isUpcoming ? (
            <div className="py-5 text-center my-4">
              <div className="display-4 mb-3 text-secondary" aria-hidden="true">
                🗓️
              </div>
              <h3 className="h5 fw-bold text-dark mb-2">
                Session on {formatDate(session.session_date)}
              </h3>
              <p className="text-body-secondary lead fs-6 mb-4" style={{ maxWidth: '48ch', margin: '0 auto' }}>
                Session access will be available on <strong>{formatDate(session.session_date)}</strong>.
              </p>
              {onClose && (
                <button
                  type="button"
                  className="btn btn-outline-secondary rounded-pill px-4"
                  onClick={onClose}
                >
                  Close Session View
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Locked notice */}
              {isLocked && (
                <div className="alert alert-secondary border-0 p-3 mb-4 rounded-4 d-flex align-items-center gap-3">
                  <span className="fs-4">🔒</span>
                  <div>
                    <h3 className="h6 fw-bold mb-0 text-dark">
                      {session.state === 'submitted' ? 'Session Submitted & Locked' : 'Session Skipped & Locked'}
                    </h3>
                    <p className="small mb-0 text-body-secondary">
                      {session.state === 'submitted'
                        ? `Officially submitted on ${formatDate(session.submitted_at)}. Measurements and check-ins are locked. Records are viewable in read-only mode.`
                        : 'A subsequent session in this program has already been submitted. This session was skipped and is permanently locked.'}
                    </p>
                  </div>
                </div>
              )}

          {/* ----------------------------------------------------------------- */}
          {/* 1. Live Session Aggregates & Survey Aggregates Card               */}
          {/* ----------------------------------------------------------------- */}
          <section className="mb-4">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <h3 className="h6 text-uppercase text-body-secondary fw-bold small mb-0">
                Live Session Aggregates
              </h3>
              <span className="text-body-secondary small">Cohort statistics with sample size (n)</span>
            </div>

            {/* 5 Core Metric Cards */}
            <div className="row g-2 mb-3">
              {/* Attendance */}
              <div className="col-6 col-md-4 col-xl">
                <div className="bb-shell h-100 p-3">
                  <span className="small text-body-secondary d-block">Attendance</span>
                  <div className="fw-bold fs-4 text-dark mt-1 bb-num">
                    {session.aggregates.present_count}
                    <span className="fs-6 fw-normal text-body-secondary"> / {session.aggregates.registered_count}</span>
                  </div>
                  <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    {attendancePct}% present (n={session.aggregates.present_count})
                  </span>
                </div>
              </div>

              {/* Measured */}
              <div className="col-6 col-md-4 col-xl">
                <div className="bb-shell h-100 p-3">
                  <span className="small text-body-secondary d-block">Measured</span>
                  <div className="fw-bold fs-4 text-dark mt-1 bb-num">{session.aggregates.measured_count}</div>
                  <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    Weight / height (n={session.aggregates.measured_count})
                  </span>
                </div>
              </div>

              {/* BMI Mean */}
              <div className="col-6 col-md-4 col-xl">
                <div className="bb-shell h-100 p-3">
                  <span className="small text-body-secondary d-block">Raw BMI Mean</span>
                  <div className="fw-bold fs-4 text-dark mt-1 bb-num">
                    {session.aggregates.bmi_mean != null ? session.aggregates.bmi_mean.toFixed(1) : '—'}
                  </div>
                  <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    kg/m² (n={session.aggregates.bmi_n})
                  </span>
                </div>
              </div>

              {/* WHtR Mean */}
              <div className="col-6 col-md-4 col-xl">
                <div className="bb-shell h-100 p-3">
                  <span className="small text-body-secondary d-block">WHtR Mean</span>
                  <div className="fw-bold fs-4 text-dark mt-1 bb-num">
                    {session.aggregates.whtr_mean != null ? session.aggregates.whtr_mean.toFixed(2) : '—'}
                  </div>
                  <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    Waist/Height (n={session.aggregates.whtr_n})
                  </span>
                </div>
              </div>

              {/* Nutritionist Checks */}
              <div className="col-12 col-md-4 col-xl">
                <div className="bb-shell h-100 p-3">
                  <span className="small text-body-secondary d-block">Nutritionist Checks</span>
                  <div className="fw-bold fs-4 text-dark mt-1 bb-num">
                    {session.aggregates.nutritionist_checks_count}
                  </div>
                  <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    Clinical checks (n={session.aggregates.nutritionist_checks_count})
                  </span>
                </div>
              </div>
            </div>

            {/* Survey Ratings Aggregates Card (Cleaned aggregates only, no individual rows) */}
            <div className="bb-shell p-3 mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <span className="small text-body-secondary fw-bold text-uppercase">
                  Beneficiary Meal Feedback Averages (1–5 scale)
                </span>
                <span className="badge badge-pale-neutral small">Survey Aggregates</span>
              </div>

              <div className="row g-2">
                {surveyQuestions.map((q) => {
                  const avgData = session.aggregates.survey_averages[q.question_id];
                  const label = q.question_id.replace('q_', '');
                  const score = avgData && avgData.n > 0 ? avgData.avg : null;
                  const pct = score ? (score / 5) * 100 : 0;

                  return (
                    <div key={q.question_id} className="col-6 col-md-3">
                      <div className="bg-white rounded-3 p-2 border">
                        <div className="d-flex justify-content-between align-items-center">
                          <span className="text-capitalize small fw-semibold text-dark">{label}</span>
                          <span className="fw-bold small text-dark bb-num">
                            {score != null ? `${score.toFixed(1)} / 5` : '—'}
                          </span>
                        </div>
                        <div className="progress bb-progress mt-1 mb-1" style={{ height: '4px' }}>
                          <div
                            className={`progress-bar ${
                              pct >= 80 ? 'bg-success' : pct >= 60 ? 'bg-warning' : 'bg-secondary'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-body-secondary" style={{ fontSize: '0.68rem' }}>
                          {avgData && avgData.n > 0 ? `n=${avgData.n} responses` : '0 responses'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Session Notes & Stored AI Observation */}
            {(session.notes.length > 0 || session.aggregates.ai_comments) && (
              <div className="row g-2">
                {session.notes.length > 0 && (
                  <div className="col-12 col-md-6">
                    <div className="bg-light-subtle rounded-4 p-3 border h-100">
                      <span className="small text-body-secondary fw-semibold text-uppercase d-block mb-1">
                        Session Notes
                      </span>
                      <div className="d-flex flex-column gap-1">
                        {session.notes.map((n) => (
                          <div key={n.note_id} className="small">
                            <span className="badge badge-pale-neutral text-uppercase me-2" style={{ fontSize: '0.65rem' }}>
                              {n.category}
                            </span>
                            <span className="text-dark">{n.note}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {session.aggregates.ai_comments && (
                  <div className="col-12 col-md-6">
                    <div className="bg-light-subtle rounded-4 p-3 border h-100">
                      <div className="d-flex justify-content-between align-items-center mb-1">
                        <span className="badge badge-pale-info" style={{ fontSize: '0.68rem' }}>
                          AI Session Insight ({session.aggregates.ai_category?.replace('_', ' ')})
                        </span>
                      </div>
                      <p className="small mb-0 text-body-secondary fst-italic">
                        &ldquo;{session.aggregates.ai_comments}&rdquo;
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ----------------------------------------------------------------- */}
          {/* 2. Action Buttons (Trigger Sub-Modals, NEVER Rendered Inline)     */}
          {/* ----------------------------------------------------------------- */}
          {/* ----------------------------------------------------------------- */}
          {/* 2. Action Buttons (Trigger Sub-Modals, Hidden on Submitted Sessions) */}
          {/* ----------------------------------------------------------------- */}
          {session.submitted_at == null && (
            <section className="mb-4">
              <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 p-3 bg-light rounded-4 border">
                <div>
                  <h3 className="h6 fw-bold mb-0 text-dark">Data Entry Actions</h3>
                  <span className="small text-body-secondary">
                    Click an action to open a dedicated sub-modal to record data
                  </span>
                </div>

                <div className="d-flex flex-wrap align-items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-sm btn-dark rounded-pill px-3 py-1 fw-semibold d-inline-flex align-items-center gap-1 shadow-sm"
                    onClick={handleOpenAddDefault}
                    disabled={isLocked || isPending}
                    title="Open Default Input sub-modal"
                  >
                    <span>+</span> Add Measurements
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-outline-dark rounded-pill px-3 py-1 fw-semibold d-inline-flex align-items-center gap-1"
                    onClick={() => setOpenNestedForm('register')}
                    disabled={isLocked || isPending}
                    title="Open Register Beneficiary sub-modal"
                  >
                    <span>+</span> Add Beneficiary
                  </button>

                  {hasNutritionists ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-success rounded-pill px-3 py-1 fw-semibold d-inline-flex align-items-center gap-1"
                      onClick={() => setOpenNestedForm('nutritionist')}
                      disabled={isLocked || isPending}
                      title="Open Nutritionist Check sub-modal"
                    >
                      <span>+</span> Add Nutritionist Check
                    </button>
                  ) : (
                    <div className="d-inline-flex flex-column align-items-start">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary disabled opacity-50 rounded-pill px-3 py-1 fw-semibold d-inline-flex align-items-center gap-1"
                        disabled
                        style={{ cursor: 'not-allowed', pointerEvents: 'auto' }}
                        title="No nutritionist assigned to this program"
                      >
                        <span>🔒</span> Nutritionist Check (Locked)
                      </button>
                      <span className="text-muted small mt-1" style={{ fontSize: '0.68rem' }}>
                        No nutritionist assigned to this program
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* ----------------------------------------------------------------- */}
          {/* 3. Session Records Entered Table (Strict Logic & Columns)         */}
          {/* - REMOVED: PRESENT column                                         */}
          {/* - REMOVED: SURVEY answers column                                  */}
          {/* - EXACTLY 3 DISTINCT COLUMNS for Nutritionist Records:            */}
          {/*   1. MUAC  2. Edema Check  3. Clinical Notes                      */}
          {/* ----------------------------------------------------------------- */}
          <section>
            <div className="d-flex justify-content-between align-items-center mb-2">
              <h3 className="h6 text-uppercase text-body-secondary fw-bold small mb-0">
                Session Records Entered ({session.records.length})
              </h3>
              <span className="small text-body-secondary">
                {isLocked ? 'Read-only records' : 'Click "Edit" on any row to update measurements'}
              </span>
            </div>

            <div className="table-responsive border rounded-4 overflow-hidden">
              <table className="table table-hover align-middle mb-0 small">
                <thead className="table-light">
                  <tr className="text-uppercase text-body-secondary" style={{ fontSize: '0.72rem' }}>
                    <th style={{ width: '85px' }}>Code</th>
                    <th>Beneficiary</th>
                    <th className="text-end">Weight</th>
                    <th className="text-end">Height</th>
                    <th className="text-end">Waist</th>
                    <th className="text-end">BMI</th>
                    <th className="text-end">WHtR</th>

                    {/* Distinct Nutritionist Column 1: MUAC */}
                    {hasNutritionistData && <th className="text-end">MUAC</th>}

                    {/* Distinct Nutritionist Column 2: Edema Check */}
                    {hasNutritionistData && <th className="text-center">Edema Check</th>}

                    {/* Distinct Nutritionist Column 3: Clinical Notes */}
                    {hasNutritionistData && <th>Clinical Notes</th>}

                    {!isLocked && <th className="text-end" style={{ width: '75px' }}>Action</th>}
                  </tr>
                </thead>
                <tbody>
                  {session.records.length === 0 ? (
                    <tr>
                      <td
                        colSpan={hasNutritionistData ? (isLocked ? 10 : 11) : (isLocked ? 7 : 8)}
                        className="text-center py-5 text-body-secondary"
                      >
                        <div className="d-flex flex-column align-items-center gap-1">
                          <span className="fs-3 text-muted">📋</span>
                          <span className="fw-semibold">No records entered for this session yet.</span>
                          <span className="small text-muted">
                            Click &quot;+ Add Measurements&quot; above to log attendee data.
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    session.records.map((r) => {
                      const isNoteExpanded = expandedNoteCode === r.beneficiary_code;

                      return (
                        <tr key={r.beneficiary_code}>
                          {/* Code */}
                          <td className="fw-mono fw-bold text-dark">#{r.beneficiary_code}</td>

                          {/* Beneficiary Name / Sex / Age */}
                          <td>
                            <div>
                              {r.name ? (
                                <span className="fw-semibold text-dark d-block">{r.name}</span>
                              ) : r.alias ? (
                                <span className="fst-italic text-dark d-block">
                                  {r.alias}{' '}
                                  <span className="badge badge-pale-neutral" style={{ fontSize: '0.62rem' }}>
                                    Alias
                                  </span>
                                </span>
                              ) : (
                                <span className="text-body-secondary">—</span>
                              )}
                              <span className="text-body-secondary" style={{ fontSize: '0.7rem' }}>
                                {r.sex === 'female' ? 'Female' : 'Male'} · {r.age} yrs
                              </span>
                            </div>
                          </td>

                          {/* Weight */}
                          <td className="text-end bb-num">
                            {r.weight_kg != null ? `${r.weight_kg.toFixed(1)} kg` : <span className="text-body-secondary">—</span>}
                          </td>

                          {/* Height */}
                          <td className="text-end bb-num">
                            {r.height_cm != null ? `${r.height_cm.toFixed(1)} cm` : <span className="text-body-secondary">—</span>}
                          </td>

                          {/* Waist */}
                          <td className="text-end bb-num">
                            {r.waist_cm != null ? `${r.waist_cm.toFixed(1)} cm` : <span className="text-body-secondary">—</span>}
                          </td>

                          {/* BMI */}
                          <td className="text-end bb-num fw-semibold">
                            {r.bmi != null ? r.bmi.toFixed(1) : <span className="text-body-secondary fw-normal">—</span>}
                          </td>

                          {/* WHtR */}
                          <td className="text-end bb-num">
                            {r.whtr != null ? r.whtr.toFixed(2) : <span className="text-body-secondary">—</span>}
                          </td>

                          {/* Distinct Nutritionist Column 1: MUAC */}
                          {hasNutritionistData && (
                            <td className="text-end bb-num">
                              {r.muac_cm != null ? (
                                <span className="badge badge-pale-info" style={{ fontSize: '0.72rem' }}>
                                  {r.muac_cm.toFixed(1)} cm
                                </span>
                              ) : (
                                <span className="text-body-secondary">—</span>
                              )}
                            </td>
                          )}

                          {/* Distinct Nutritionist Column 2: Edema Check */}
                          {hasNutritionistData && (
                            <td className="text-center">
                              {r.edema === true ? (
                                <span className="badge badge-pale-danger" style={{ fontSize: '0.68rem' }}>
                                  Edema Detected
                                </span>
                              ) : r.edema === false ? (
                                <span className="badge badge-pale-success" style={{ fontSize: '0.68rem' }}>
                                  No Edema
                                </span>
                              ) : (
                                <span className="text-body-secondary">—</span>
                              )}
                            </td>
                          )}

                          {/* Distinct Nutritionist Column 3: Clinical Notes */}
                          {hasNutritionistData && (
                            <td>
                              {r.clinical_notes ? (
                                <div>
                                  <button
                                    type="button"
                                    className="btn btn-link btn-sm p-0 text-start text-decoration-none text-dark"
                                    style={{ fontSize: '0.72rem' }}
                                    onClick={() =>
                                      setExpandedNoteCode(isNoteExpanded ? null : r.beneficiary_code)
                                    }
                                  >
                                    {isNoteExpanded ? '▾ Close Note' : `▸ "${r.clinical_notes.slice(0, 28)}${r.clinical_notes.length > 28 ? '...' : ''}"`}
                                  </button>
                                  {isNoteExpanded && (
                                    <div className="p-2 bg-light rounded mt-1 text-dark small border shadow-sm">
                                      &ldquo;{r.clinical_notes}&rdquo;
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="text-body-secondary">—</span>
                              )}
                            </td>
                          )}

                          {/* Action (Edit Record) */}
                          {!isLocked && (
                            <td className="text-end">
                              <button
                                type="button"
                                className="btn btn-sm btn-outline-secondary rounded-pill px-2 py-0"
                                style={{ fontSize: '0.72rem' }}
                                onClick={() => handleEditRecord(r)}
                                title="Edit default measurements"
                              >
                                Edit
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
            </>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* SUB-MODAL 1: DEFAULT INPUT FORM                                     */}
      {/* ------------------------------------------------------------------- */}
      {openNestedForm === 'default' && (
        <div className="bb-nested-overlay" onClick={() => setOpenNestedForm(null)}>
          <div className="bb-nested-dialog bb-scrollable p-4" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div>
                <h4 className="h5 fw-bold mb-0">Record Attendance &amp; Measurements</h4>
                <p className="text-body-secondary small mb-0">Log check-in, anthropometrics, and survey answers</p>
              </div>
              <button
                type="button"
                className="btn btn-light rounded-circle p-1"
                style={{ width: '32px', height: '32px' }}
                onClick={() => setOpenNestedForm(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {duplicateNotice && (
              <div className="alert alert-warning border-0 p-3 rounded-3 small mb-3">
                ⚠️ <strong>Measurement Notice:</strong> Beneficiary #{defaultBenCode} already has recorded
                measurements in Timeline {duplicateNotice.seq} on {formatDate(duplicateNotice.date)}. Saving
                here will update their record for this session.
              </div>
            )}

            <form onSubmit={handleSaveDefaultInput}>
              {/* Beneficiary Picker */}
              <div className="mb-3">
                <label className="form-label small fw-semibold">Select Beneficiary *</label>
                <select
                  className="form-select form-select-sm"
                  value={defaultBenCode}
                  onChange={(e) => setDefaultBenCode(e.target.value)}
                  disabled={isLocked || isPending}
                  required
                >
                  {registeredBeneficiaries.map((b) => (
                    <option key={b.beneficiary_code} value={b.beneficiary_code}>
                      #{b.beneficiary_code} — {b.displayName} ({b.sex}, {b.age}y)
                    </option>
                  ))}
                </select>
              </div>

              {/* Attendance Switch */}
              <div className="form-check form-switch mb-3">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="defaultPresentSwitch"
                  checked={defaultPresent}
                  onChange={(e) => setDefaultPresent(e.target.checked)}
                  disabled={isLocked || isPending}
                />
                <label className="form-check-label small fw-semibold" htmlFor="defaultPresentSwitch">
                  Mark as Present for this Session
                </label>
              </div>

              {/* Anthropometrics */}
              <div className="row g-2 mb-3">
                <div className="col-4">
                  <label className="form-label small mb-1">Weight (kg)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    max="300"
                    className="form-control form-control-sm"
                    placeholder="e.g. 14.5"
                    value={defaultWeight}
                    onChange={(e) => setDefaultWeight(e.target.value)}
                    disabled={isLocked || isPending}
                  />
                </div>
                <div className="col-4">
                  <label className="form-label small mb-1">Height (cm)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="30"
                    max="250"
                    className="form-control form-control-sm"
                    placeholder="e.g. 98.0"
                    value={defaultHeight}
                    onChange={(e) => setDefaultHeight(e.target.value)}
                    disabled={isLocked || isPending}
                  />
                </div>
                <div className="col-4">
                  <label className="form-label small mb-1">Waist (cm)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="20"
                    max="200"
                    className="form-control form-control-sm"
                    placeholder="e.g. 52.0"
                    value={defaultWaist}
                    onChange={(e) => setDefaultWaist(e.target.value)}
                    disabled={isLocked || isPending}
                  />
                </div>
              </div>

              {/* Survey Ratings (1-5) */}
              <div className="border rounded-3 p-3 bg-light-subtle mb-3">
                <span className="small fw-semibold d-block mb-2">Meal Survey Ratings (1 = Low, 5 = High)</span>
                <div className="row g-2">
                  {surveyQuestions.map((q) => {
                    const val = surveyVals[q.question_id] ?? 4;
                    const label = q.question_id.replace('q_', '');
                    return (
                      <div key={q.question_id} className="col-6">
                        <label className="form-label small text-capitalize mb-1 d-flex justify-content-between">
                          <span>{label}:</span>
                          <strong>{val} / 5</strong>
                        </label>
                        <input
                          type="range"
                          className="form-range"
                          min="1"
                          max="5"
                          step="1"
                          value={val}
                          onChange={(e) =>
                            setSurveyVals({ ...surveyVals, [q.question_id]: Number(e.target.value) })
                          }
                          disabled={isLocked || isPending}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="d-flex justify-content-end gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary rounded-pill px-3"
                  onClick={() => setOpenNestedForm(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-success rounded-pill px-4 fw-semibold"
                  disabled={isLocked || isPending}
                >
                  {isPending ? 'Saving...' : 'Save Measurements'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* SUB-MODAL 2: REGISTER BENEFICIARY FORM                              */}
      {/* ------------------------------------------------------------------- */}
      {openNestedForm === 'register' && (
        <div className="bb-nested-overlay" onClick={() => setOpenNestedForm(null)}>
          <div className="bb-nested-dialog bb-scrollable p-4" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div>
                <h4 className="h5 fw-bold mb-0">Register New Beneficiary</h4>
                <p className="text-body-secondary small mb-0">Enroll attendee into this feeding program</p>
              </div>
              <button
                type="button"
                className="btn btn-light rounded-circle p-1"
                style={{ width: '32px', height: '32px' }}
                onClick={() => setOpenNestedForm(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRegisterBeneficiary}>
              <div className="row g-2 mb-3">
                <div className="col-4">
                  <label className="form-label small mb-1">Birth Month *</label>
                  <select
                    className="form-select form-select-sm"
                    value={regBirthMonth}
                    onChange={(e) => setRegBirthMonth(Number(e.target.value))}
                    disabled={isLocked || isPending}
                  >
                    {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                      <option key={m} value={m}>
                        {m} - {new Date(2000, m - 1).toLocaleString('default', { month: 'short' })}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-4">
                  <label className="form-label small mb-1">Birth Year *</label>
                  <input
                    type="number"
                    min="1920"
                    max={Number(today.slice(0, 4))}
                    className="form-control form-control-sm"
                    value={regBirthYear}
                    onChange={(e) => setRegBirthYear(Number(e.target.value))}
                    disabled={isLocked || isPending}
                    required
                  />
                </div>

                <div className="col-4">
                  <label className="form-label small mb-1">Sex *</label>
                  <select
                    className="form-select form-select-sm"
                    value={regSex}
                    onChange={(e) => setRegSex(e.target.value as 'female' | 'male')}
                    disabled={isLocked || isPending}
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </div>
              </div>

              {/* Full Name (Optional) */}
              <div className="mb-3">
                <label className="form-label small mb-1">
                  Full Name <span className="text-body-secondary">(Optional: alias generated if empty)</span>
                </label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  placeholder="e.g. Juanita Cruz"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  disabled={isLocked || isPending}
                />
              </div>

              {/* Guardian fields strictly only rendered if minor (< 18 years) */}
              {regIsMinor && (
                <div className="border rounded-3 p-3 bg-light-subtle mb-3">
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <span className="small fw-semibold">
                      Guardian &amp; Consent {requiresGuardian ? <span className="text-danger">* (Required for Named Minor)</span> : '(Optional)'}
                    </span>
                    <span className="badge badge-pale-warning" style={{ fontSize: '0.65rem' }}>
                      Minor ({Math.floor(regMonths / 12)}y {regMonths % 12}m)
                    </span>
                  </div>

                  <div className="row g-2">
                    <div className="col-12 col-md-4">
                      <label className="form-label small mb-1">Guardian Name {requiresGuardian && '*'}</label>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="e.g. Maria Cruz"
                        value={regGuardianName}
                        onChange={(e) => setRegGuardianName(e.target.value)}
                        disabled={isLocked || isPending}
                        required={requiresGuardian}
                      />
                    </div>

                    <div className="col-6 col-md-4">
                      <label className="form-label small mb-1">Contact Number {requiresGuardian && '*'}</label>
                      <input
                        type="text"
                        className="form-control form-control-sm"
                        placeholder="0917-123-4567"
                        value={regGuardianNumber}
                        onChange={(e) => setRegGuardianNumber(e.target.value)}
                        disabled={isLocked || isPending}
                        required={requiresGuardian}
                      />
                    </div>

                    <div className="col-6 col-md-4">
                      <label className="form-label small mb-1">Relationship {requiresGuardian && '*'}</label>
                      <select
                        className="form-select form-select-sm"
                        value={regGuardianRel}
                        onChange={(e) => setRegGuardianRel(e.target.value)}
                        disabled={isLocked || isPending}
                        required={requiresGuardian}
                      >
                        <option value="mother">Mother</option>
                        <option value="father">Father</option>
                        <option value="grandmother">Grandmother</option>
                        <option value="grandfather">Grandfather</option>
                        <option value="aunt">Aunt</option>
                        <option value="uncle">Uncle</option>
                        <option value="guardian">Legal Guardian</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Allergies */}
              <div className="mb-3">
                <label className="form-label small fw-semibold d-block mb-1">Allergies (Optional)</label>
                <div className="d-flex flex-wrap gap-2">
                  {availableAllergies.map((a) => {
                    const isChecked = regSelectedAllergies.includes(a.allergy_id);
                    return (
                      <div key={a.allergy_id} className="form-check form-check-inline">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`reg_allergy_${a.allergy_id}`}
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setRegSelectedAllergies([...regSelectedAllergies, a.allergy_id]);
                            } else {
                              setRegSelectedAllergies(
                                regSelectedAllergies.filter((id) => id !== a.allergy_id)
                              );
                            }
                          }}
                          disabled={isLocked || isPending}
                        />
                        <label className="form-check-label small" htmlFor={`reg_allergy_${a.allergy_id}`}>
                          {a.name}
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="d-flex justify-content-end gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary rounded-pill px-3"
                  onClick={() => setOpenNestedForm(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-success rounded-pill px-4 fw-semibold"
                  disabled={isLocked || isPending}
                >
                  {isPending ? 'Registering...' : 'Register Beneficiary'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* SUB-MODAL 3: NUTRITIONIST CHECK FORM                                */}
      {/* ------------------------------------------------------------------- */}
      {openNestedForm === 'nutritionist' && (
        <div className="bb-nested-overlay" onClick={() => setOpenNestedForm(null)}>
          <div className="bb-nested-dialog bb-scrollable p-4" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-center mb-3">
              <div>
                <h4 className="h5 fw-bold mb-0">Clinical Nutritionist Check</h4>
                <p className="text-body-secondary small mb-0">MUAC screening, bilateral edema evaluation, and clinical notes</p>
              </div>
              <button
                type="button"
                className="btn btn-light rounded-circle p-1"
                style={{ width: '32px', height: '32px' }}
                onClick={() => setOpenNestedForm(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveNutritionist}>
              <div className="row g-2 mb-3">
                <div className="col-12 col-md-6">
                  <label className="form-label small fw-semibold">Nutritionist *</label>
                  <select
                    className="form-select form-select-sm"
                    value={nutriId}
                    onChange={(e) => setNutriId(e.target.value)}
                    disabled={isLocked || isPending}
                    required
                  >
                    {assignedNutritionists.map((n) => (
                      <option key={n.nutritionist_id} value={n.nutritionist_id}>
                        {n.name} {n.credentials ? `(${n.credentials})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-12 col-md-6">
                  <label className="form-label small fw-semibold">Beneficiary *</label>
                  <select
                    className="form-select form-select-sm"
                    value={nutriBenCode}
                    onChange={(e) => setNutriBenCode(e.target.value)}
                    disabled={isLocked || isPending}
                    required
                  >
                    {registeredBeneficiaries.map((b) => (
                      <option key={b.beneficiary_code} value={b.beneficiary_code}>
                        #{b.beneficiary_code} — {b.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="row g-2 mb-3">
                <div className="col-6">
                  <label className="form-label small fw-semibold">MUAC (cm)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="5"
                    max="50"
                    className="form-control form-control-sm"
                    placeholder="e.g. 13.5"
                    value={nutriMuac}
                    onChange={(e) => setNutriMuac(e.target.value)}
                    disabled={isLocked || isPending}
                  />
                </div>

                <div className="col-6 d-flex align-items-end">
                  <div className="form-check form-switch mb-1">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="nutriEdemaSwitch"
                      checked={nutriEdema}
                      onChange={(e) => setNutriEdema(e.target.checked)}
                      disabled={isLocked || isPending}
                    />
                    <label className="form-check-label small fw-semibold ms-1 text-danger" htmlFor="nutriEdemaSwitch">
                      Bilateral Edema Present
                    </label>
                  </div>
                </div>
              </div>

              <div className="mb-3">
                <label className="form-label small fw-semibold">Clinical Notes</label>
                <textarea
                  className="form-control form-control-sm"
                  rows={3}
                  placeholder="Appetite test result, medical observations, counseling..."
                  value={nutriNotes}
                  onChange={(e) => setNutriNotes(e.target.value)}
                  disabled={isLocked || isPending}
                />
              </div>

              <div className="d-flex justify-content-end gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary rounded-pill px-3"
                  onClick={() => setOpenNestedForm(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-sm btn-success rounded-pill px-4 fw-semibold"
                  disabled={isLocked || isPending}
                >
                  {isPending ? 'Saving...' : 'Save Clinical Check'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------- */}
      {/* CONFIRMATION MODAL: SUBMIT SESSION TRANSACTION                      */}
      {/* ------------------------------------------------------------------- */}
      {showSubmitModal && (
        <div className="bb-nested-overlay" onClick={() => setShowSubmitModal(false)}>
          <div className="bb-nested-dialog p-4" onClick={(e) => e.stopPropagation()}>
            <div className="d-flex align-items-center gap-2 mb-2">
              <span className="fs-4">⚠️</span>
              <h4 className="h5 fw-bold mb-0">Submit Session on {formatDate(session.session_date)}?</h4>
            </div>
            <p className="text-body-secondary small mb-3">
              Submitting this session will finalize all records and perform database reconciliation:
            </p>

            <ul className="small text-body-secondary mb-3">
              <li>
                <strong>Locking:</strong> This session will be officially submitted as of {formatDate(today)} and
                locked from further data modifications.
              </li>
              <li>
                <strong>Absence Reconciliation:</strong> Any registered beneficiary without a record in this
                session will automatically receive an <code>is_present = FALSE</code> check-in.
              </li>
              {closingTimeline && (
                <li className="text-success fw-semibold">
                  <strong>Timeline {closingTimeline.seq} Closure:</strong> This session is the end session of
                  Timeline {closingTimeline.seq}. Submitting will officially close Timeline {closingTimeline.seq},
                  calculate qualifying nutritional statuses (Baseline / Monitor / Monitor closely), and store AI trend interpretations.
                </li>
              )}
            </ul>

            <div className="d-flex justify-content-end gap-2">
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rounded-pill px-3"
                onClick={() => setShowSubmitModal(false)}
                disabled={isPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-success rounded-pill px-4 fw-semibold shadow-sm"
                onClick={handleConfirmSubmit}
                disabled={isPending}
              >
                {isPending ? 'Submitting...' : 'Confirm Submission'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
