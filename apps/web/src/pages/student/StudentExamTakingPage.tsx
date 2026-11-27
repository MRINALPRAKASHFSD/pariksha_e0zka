import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import {
  AlertTriangle,
  Bookmark,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eraser,
  Maximize2,
  Monitor,
  PauseCircle,
  RefreshCw,
  Send,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  IntegrityEventConfidence,
  IntegrityEventType,
  QuestionType,
  isSubjectiveQuestionType,
  type ExamHeartbeatResultDto,
  type ExamSubmissionReceiptDto,
  type RecordIntegrityEventResultDto,
  type ResumeAttemptResultDto,
  type SaveExamAnswerResultDto,
  type StudentExamAnswerDto,
  type StudentExamAttemptDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import {
  clearPendingProctoringStreams,
  consumePendingProctoringStreams,
} from "@/lib/activeProctoringStreams";
import { useExamLockdown, type LockdownViolationPayload } from "@/hooks/useExamLockdown";
import { useProctoringMedia } from "@/hooks/useProctoringMedia";
import { useToast } from "@/context/toast-context";
import {
  formatCountdown,
  formatDateTimeShort,
  formatQuestionTypeLabel,
  getAttemptStatusBadgeVariant,
} from "@/lib/examUi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface LocalAnswerState {
  selectedOptionIds: string[];
  textAnswer: string;
  markedForReview: boolean;
  revision: number;
  lastClientSequence: number;
  lastSavedAt: string | null;
}

type AutosaveStatus = "idle" | "saving" | "saved" | "error";

function isQuestionAnswered(ans?: LocalAnswerState): boolean {
  if (!ans) return false;
  return ans.selectedOptionIds.length > 0 || ans.textAnswer.trim().length > 0;
}

export function StudentExamTakingPage() {
  const { examId, attemptId } = useParams<{ examId: string; attemptId: string }>();
  const { pushToast } = useToast();

  const [attempt, setAttempt] = useState<StudentExamAttemptDto | null>(null);
  const [answers, setAnswers] = useState<Record<string, LocalAnswerState>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");
  const [autosaveError, setAutosaveError] = useState<string | null>(null);
  const [lastSavedLabel, setLastSavedLabel] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [violationCount, setViolationCount] = useState(0);
  const [strikeThreshold, setStrikeThreshold] = useState(2);
  const [warningModal, setWarningModal] = useState<{
    strike: number;
    threshold: number;
    remaining: number;
    eventType: string;
    message: string;
  } | null>(null);
  const [lockdownNotice, setLockdownNotice] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const serverOffsetMsRef = useRef<number>(0);
  const seqRef = useRef<number>(0);
  const hbSeqRef = useRef<number>(0);
  const answersRef = useRef<Record<string, LocalAnswerState>>({});
  const attemptRef = useRef<StudentExamAttemptDto | null>(null);
  const debounceTimersRef = useRef<Record<string, number>>({});
  const dirtyQuestionIdsRef = useRef<Set<string>>(new Set());
  const expiryPollTriggeredRef = useRef<boolean>(false);
  const adoptedAttemptIdRef = useRef<string | null>(null);
  const webcamThumbRef = useRef<HTMLVideoElement | null>(null);

  answersRef.current = answers;
  attemptRef.current = attempt;

  const hydrateFromAttempt = useCallback((dto: StudentExamAttemptDto) => {
    setAttempt(dto);
    setViolationCount(dto.violationCount);
    setStrikeThreshold(dto.strikeThreshold);
    serverOffsetMsRef.current = Date.parse(dto.serverNow) - Date.now();
    const initialRemaining = Math.max(
      0,
      Math.floor((Date.parse(dto.expiresAt) - Date.parse(dto.serverNow)) / 1000),
    );
    setRemainingSeconds(
      dto.status === "IN_PROGRESS" || dto.status === "PAUSED" ? initialRemaining : 0,
    );

    const map: Record<string, LocalAnswerState> = {};
    let maxSeq = 0;
    for (const q of dto.questions) {
      map[q.id] = {
        selectedOptionIds: [],
        textAnswer: "",
        markedForReview: false,
        revision: 0,
        lastClientSequence: 0,
        lastSavedAt: null,
      };
    }
    for (const saved of dto.answers) {
      map[saved.questionId] = {
        selectedOptionIds: saved.selectedOptionIds,
        textAnswer: saved.textAnswer ?? "",
        markedForReview: saved.markedForReview,
        revision: saved.revision,
        lastClientSequence: saved.lastClientSequence,
        lastSavedAt: saved.lastSavedAt,
      };
      if (saved.lastClientSequence > maxSeq) maxSeq = saved.lastClientSequence;
    }
    seqRef.current = Math.max(seqRef.current, maxSeq);
    answersRef.current = map;
    setAnswers(map);
  }, []);

  const loadAttempt = useCallback(async () => {
    if (!examId || !attemptId) return;
    try {
      const dto = await apiRequest<StudentExamAttemptDto>(
        `/student/exams/${examId}/attempts/${attemptId}`,
      );
      hydrateFromAttempt(dto);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load exam attempt.");
    } finally {
      setLoading(false);
    }
  }, [examId, attemptId, hydrateFromAttempt]);

  useEffect(() => {
    setLoading(true);
    void loadAttempt();
  }, [loadAttempt]);

  // Browser online/offline status listener
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Server-synchronized countdown timer
  useEffect(() => {
    if (!attempt) return;
    if (attempt.status !== "IN_PROGRESS" && attempt.status !== "PAUSED") {
      setRemainingSeconds(0);
      return;
    }

    const tick = () => {
      const serverNowApprox = Date.now() + serverOffsetMsRef.current;
      const secs = Math.max(0, Math.floor((Date.parse(attempt.expiresAt) - serverNowApprox) / 1000));
      setRemainingSeconds(secs);
      if (secs <= 0 && !expiryPollTriggeredRef.current) {
        expiryPollTriggeredRef.current = true;
        void loadAttempt();
      }
    };

    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [attempt, loadAttempt]);

  // Real-time notification when background worker expires, strikes pause/finalize, or admin terminates attempt
  const reportIntegrityEvent = useCallback(
    async (payload: LockdownViolationPayload) => {
      if (!examId || !attemptId) return;
      const cur = attemptRef.current;
      if (!cur || cur.isLocked || cur.allowUnproctoredDev) return;

      try {
        const res = await apiRequest<RecordIntegrityEventResultDto>(
          `/student/exams/${examId}/attempts/${attemptId}/integrity-events`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        setViolationCount(res.violationCount);
        setStrikeThreshold(res.strikeThreshold);
        if (res.warningIssued) {
          setWarningModal({
            strike: res.violationCount,
            threshold: res.strikeThreshold,
            remaining: res.remainingStrikes,
            eventType: res.event.eventType,
            message: res.event.description,
          });
        }
        if (res.paused || res.autoSubmitted) {
          await loadAttempt();
        }
      } catch (err) {
        if (
          err instanceof ApiClientError &&
          (err.code === "ATTEMPT_LOCKED" || err.code === "ATTEMPT_EXPIRED")
        ) {
          await loadAttempt();
        }
      }
    },
    [examId, attemptId, loadAttempt],
  );

  const isProctoredActive = Boolean(
    attempt && !attempt.isLocked && !attempt.allowUnproctoredDev,
  );

  const media = useProctoringMedia({
    enabled: isProctoredActive,
    onCameraInterrupted: (reason) => {
      void reportIntegrityEvent({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.CAMERA_INTERRUPTED,
        description: reason,
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    },
    onScreenShareInterrupted: (reason) => {
      void reportIntegrityEvent({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.SCREEN_SHARE_INTERRUPTED,
        description: reason,
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    },
    onPermissionDenied: (kind, reason) => {
      void reportIntegrityEvent({
        clientEventId: crypto.randomUUID(),
        eventType: IntegrityEventType.PERMISSION_DENIED,
        description: reason,
        confidence: IntegrityEventConfidence.CLIENT_REPORTED,
        metadata: { mediaKind: kind },
      });
    },
  });

  const { stopAllMediaTracks, exitFullscreenIfActive, adoptStreams, syncTrackHealth } = media;

  // Adopt MediaStreams handed over from StudentExamPreflightPage on initial launch
  useEffect(() => {
    if (!attempt || attempt.isLocked || attempt.allowUnproctoredDev) return;
    if (adoptedAttemptIdRef.current === attempt.id) return;
    adoptedAttemptIdRef.current = attempt.id;
    const pending = consumePendingProctoringStreams(attempt.id);
    if (pending) {
      adoptStreams(pending);
    }
  }, [attempt, adoptStreams]);

  // Attach live muted webcam preview locally (zero server video upload)
  useEffect(() => {
    const videoEl = webcamThumbRef.current;
    if (!videoEl) return;
    try {
      if (media.state.cameraStream) {
        videoEl.srcObject = media.state.cameraStream;
        void videoEl.play().catch(() => {
          // Ignore transient autoplay promises
        });
      } else {
        videoEl.srcObject = null;
      }
    } catch {
      videoEl.srcObject = null;
    }
  }, [media.state.cameraStream]);

  // Ensure tracks and fullscreen release immediately when attempt finishes or becomes locked
  useEffect(() => {
    if (attempt?.isLocked) {
      stopAllMediaTracks();
      clearPendingProctoringStreams();
      void exitFullscreenIfActive();
    }
  }, [attempt?.isLocked, stopAllMediaTracks, exitFullscreenIfActive]);

  const missingRequiredMedia = Boolean(
    isProctoredActive &&
      attempt &&
      ((attempt.policy.requireWebcam && !media.state.cameraActive) ||
        (attempt.policy.requireScreenShare && !media.state.screenShareActive) ||
        (attempt.policy.requireFullscreen && !media.state.fullscreenActive)),
  );
  const recoveryOverlayOpen = Boolean(
    isProctoredActive && attempt && (attempt.status === "PAUSED" || missingRequiredMedia),
  );

  useExamLockdown({
    enabled: Boolean(isProctoredActive && attempt?.status === "IN_PROGRESS"),
    paused: Boolean(attempt?.status === "PAUSED" || recoveryOverlayOpen),
    policy: attempt?.policy ?? null,
    onViolation: (payload) => {
      void reportIntegrityEvent(payload);
    },
    onNotice: (msg) => {
      setLockdownNotice(msg);
    },
  });

  // Auto-clear transient restriction toast
  useEffect(() => {
    if (!lockdownNotice) return;
    const timer = window.setTimeout(() => setLockdownNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [lockdownNotice]);

  // Periodic monotonic server heartbeat (reconciles clock, strike count, media telemetry)
  useEffect(() => {
    if (!examId || !attempt || attempt.isLocked || attempt.allowUnproctoredDev) return;
    if (attempt.status !== "IN_PROGRESS" && attempt.status !== "PAUSED") return;

    const intervalMs = Math.max(5000, (attempt.policy.heartbeatIntervalSeconds ?? 20) * 1000);
    const sendHeartbeat = async () => {
      const nextSeq = ++hbSeqRef.current;
      const health = syncTrackHealth();
      try {
        const hb = await apiRequest<ExamHeartbeatResultDto>(
          `/student/exams/${examId}/attempts/${attempt.id}/heartbeat`,
          {
            method: "POST",
            body: JSON.stringify({
              sequence: nextSeq,
              cameraActive: health.cameraActive,
              screenShareActive: health.screenShareActive,
              fullscreenActive: health.fullscreenActive,
              connectionOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
              clientTimestamp: new Date().toISOString(),
            }),
          },
        );
        serverOffsetMsRef.current = Date.parse(hb.serverNow) - Date.now();
        setViolationCount(hb.violationCount);
        setStrikeThreshold(hb.strikeThreshold);
        if (hb.status !== attemptRef.current?.status) {
          await loadAttempt();
        }
      } catch (err) {
        if (
          err instanceof ApiClientError &&
          (err.code === "ATTEMPT_LOCKED" || err.code === "ATTEMPT_EXPIRED")
        ) {
          await loadAttempt();
        }
      }
    };

    const timer = window.setInterval(() => void sendHeartbeat(), intervalMs);
    return () => window.clearInterval(timer);
  }, [examId, attempt, syncTrackHealth, loadAttempt]);

  useEffect(() => {
    if (!attemptId) return;
    const socket = io({
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socket.emit("proctoring:join-attempt", { attemptId });

    socket.on(
      "proctoring:warning",
      (payload: {
        attemptId?: string;
        violationCount?: number;
        strikeThreshold?: number;
        remainingStrikes?: number;
        eventType?: string;
        description?: string;
      }) => {
        if (payload?.attemptId !== attemptId) return;
        if (typeof payload.violationCount === "number") setViolationCount(payload.violationCount);
        if (typeof payload.strikeThreshold === "number") setStrikeThreshold(payload.strikeThreshold);
        setWarningModal({
          strike: payload.violationCount ?? 1,
          threshold: payload.strikeThreshold ?? 2,
          remaining: payload.remainingStrikes ?? 1,
          eventType: payload.eventType ?? "INTEGRITY_WARNING",
          message: payload.description ?? "An integrity policy warning was recorded.",
        });
      },
    );

    socket.on("proctoring:attempt-paused", (payload: { attemptId?: string }) => {
      if (payload?.attemptId === attemptId) {
        void loadAttempt();
      }
    });

    socket.on("exam:attempt-finalized", (payload: { attemptId?: string }) => {
      if (payload?.attemptId === attemptId) {
        stopAllMediaTracks();
        void loadAttempt();
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [attemptId, loadAttempt, stopAllMediaTracks]);

  // Clean up debounce timers on unmount
  useEffect(() => {
    const timers = debounceTimersRef.current;
    return () => {
      for (const timerId of Object.values(timers)) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  const persistAnswer = useCallback(
    async (questionId: string, snapshot?: LocalAnswerState) => {
      if (!examId || !attemptId) return;
      const target = snapshot ?? answersRef.current[questionId];
      if (!target) return;

      const clientSequence = ++seqRef.current;
      setAutosaveStatus("saving");
      setAutosaveError(null);

      try {
        const res = await apiRequest<SaveExamAnswerResultDto>(
          `/student/exams/${examId}/attempts/${attemptId}/answers`,
          {
            method: "PUT",
            body: JSON.stringify({
              questionId,
              selectedOptionIds: target.selectedOptionIds,
              textAnswer: target.textAnswer || null,
              markedForReview: target.markedForReview,
              clientSequence,
            }),
          },
        );

        serverOffsetMsRef.current = Date.parse(res.serverNow) - Date.now();
        dirtyQuestionIdsRef.current.delete(questionId);

        if (!res.staleIgnored) {
          const savedAnswer: StudentExamAnswerDto = res.answer;
          setAnswers((prev) => {
            const current = prev[questionId];
            if (current && current.lastClientSequence > savedAnswer.lastClientSequence) {
              return prev;
            }
            return {
              ...prev,
              [questionId]: {
                selectedOptionIds: savedAnswer.selectedOptionIds,
                textAnswer: savedAnswer.textAnswer ?? "",
                markedForReview: savedAnswer.markedForReview,
                revision: savedAnswer.revision,
                lastClientSequence: savedAnswer.lastClientSequence,
                lastSavedAt: savedAnswer.lastSavedAt,
              },
            };
          });
        }

        setAutosaveStatus("saved");
        setLastSavedLabel(
          new Date().toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }),
        );
      } catch (err) {
        if (
          err instanceof ApiClientError &&
          (err.code === "ATTEMPT_EXPIRED" ||
            err.code === "ATTEMPT_LOCKED" ||
            err.code === "ATTEMPT_PAUSED")
        ) {
          await loadAttempt();
          return;
        }
        setAutosaveStatus("error");
        setAutosaveError(
          err instanceof ApiClientError ? err.message : "Autosave failed. Click Retry Save.",
        );
      }
    },
    [examId, attemptId, loadAttempt],
  );

  const scheduleDebouncedSave = useCallback(
    (questionId: string, nextState: LocalAnswerState, delayMs: number) => {
      dirtyQuestionIdsRef.current.add(questionId);
      const existingTimer = debounceTimersRef.current[questionId];
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        delete debounceTimersRef.current[questionId];
      }

      if (delayMs <= 0) {
        void persistAnswer(questionId, nextState);
        return;
      }

      setAutosaveStatus("saving");
      debounceTimersRef.current[questionId] = window.setTimeout(() => {
        delete debounceTimersRef.current[questionId];
        void persistAnswer(questionId);
      }, delayMs);
    },
    [persistAnswer],
  );

  const flushPendingSaves = useCallback(async () => {
    for (const [qId, timerId] of Object.entries(debounceTimersRef.current)) {
      window.clearTimeout(timerId);
      delete debounceTimersRef.current[qId];
      dirtyQuestionIdsRef.current.add(qId);
    }

    const dirtyIds = Array.from(dirtyQuestionIdsRef.current);
    for (const qId of dirtyIds) {
      await persistAnswer(qId);
    }
  }, [persistAnswer]);

  const handleSelectSingleOption = (questionId: string, optionId: string) => {
    const current = answers[questionId] ?? {
      selectedOptionIds: [],
      textAnswer: "",
      markedForReview: false,
      revision: 0,
      lastClientSequence: 0,
      lastSavedAt: null,
    };
    const nextState: LocalAnswerState = {
      ...current,
      selectedOptionIds: [optionId],
    };
    setAnswers((prev) => ({ ...prev, [questionId]: nextState }));
    scheduleDebouncedSave(questionId, nextState, 0);
  };

  const handleToggleMultiOption = (questionId: string, optionId: string) => {
    const current = answers[questionId] ?? {
      selectedOptionIds: [],
      textAnswer: "",
      markedForReview: false,
      revision: 0,
      lastClientSequence: 0,
      lastSavedAt: null,
    };
    const exists = current.selectedOptionIds.includes(optionId);
    const nextSelected = exists
      ? current.selectedOptionIds.filter((id) => id !== optionId)
      : [...current.selectedOptionIds, optionId];
    const nextState: LocalAnswerState = {
      ...current,
      selectedOptionIds: nextSelected,
    };
    setAnswers((prev) => ({ ...prev, [questionId]: nextState }));
    scheduleDebouncedSave(questionId, nextState, 0);
  };

  const handleTextAnswerChange = (questionId: string, textAnswer: string) => {
    const current = answers[questionId] ?? {
      selectedOptionIds: [],
      textAnswer: "",
      markedForReview: false,
      revision: 0,
      lastClientSequence: 0,
      lastSavedAt: null,
    };
    const nextState: LocalAnswerState = {
      ...current,
      textAnswer,
    };
    setAnswers((prev) => ({ ...prev, [questionId]: nextState }));
    scheduleDebouncedSave(questionId, nextState, 400);
  };

  const handleToggleMarkForReview = (questionId: string) => {
    const current = answers[questionId] ?? {
      selectedOptionIds: [],
      textAnswer: "",
      markedForReview: false,
      revision: 0,
      lastClientSequence: 0,
      lastSavedAt: null,
    };
    const nextState: LocalAnswerState = {
      ...current,
      markedForReview: !current.markedForReview,
    };
    setAnswers((prev) => ({ ...prev, [questionId]: nextState }));
    scheduleDebouncedSave(questionId, nextState, 0);
  };

  const handleClearResponse = (questionId: string) => {
    const current = answers[questionId] ?? {
      selectedOptionIds: [],
      textAnswer: "",
      markedForReview: false,
      revision: 0,
      lastClientSequence: 0,
      lastSavedAt: null,
    };
    const nextState: LocalAnswerState = {
      ...current,
      selectedOptionIds: [],
      textAnswer: "",
    };
    setAnswers((prev) => ({ ...prev, [questionId]: nextState }));
    scheduleDebouncedSave(questionId, nextState, 0);
  };

  const handleOpenSubmitConfirmation = async () => {
    await flushPendingSaves();
    setSubmitDialogOpen(true);
  };

  const handleConfirmSubmit = async () => {
    if (!examId || !attemptId) return;
    setSubmitting(true);
    try {
      await flushPendingSaves();
      const res = await apiRequest<{
        receipt: ExamSubmissionReceiptDto;
        alreadyFinalized: boolean;
      }>(`/student/exams/${examId}/attempts/${attemptId}/submit`, {
        method: "POST",
        body: JSON.stringify({ confirmSubmit: true }),
      });
      setSubmitDialogOpen(false);
      media.stopAllMediaTracks();
      clearPendingProctoringStreams();
      void media.exitFullscreenIfActive();
      pushToast({
        title: "Examination submitted",
        description: `Receipt: ${res.receipt.receiptCode}`,
      });
      await loadAttempt();
    } catch (err) {
      pushToast({
        title: "Submission failed",
        description: err instanceof ApiClientError ? err.message : "Could not finalize attempt.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleResumeProctoredAttempt = async () => {
    if (!examId || !attemptId || !attempt) return;
    setResuming(true);
    try {
      const health = media.syncTrackHealth();
      if (attempt.status === "PAUSED") {
        const res = await apiRequest<ResumeAttemptResultDto>(
          `/student/exams/${examId}/attempts/${attemptId}/resume`,
          {
            method: "POST",
            body: JSON.stringify({
              cameraActive: health.cameraActive,
              screenShareActive: health.screenShareActive,
              fullscreenActive: health.fullscreenActive,
              displaySurface: media.state.displaySurface,
            }),
          },
        );
        hydrateFromAttempt(res.attempt);
        setWarningModal(null);
        pushToast({ title: "Proctoring resumed", description: "You may continue your examination." });
      } else {
        const nextSeq = ++hbSeqRef.current;
        await apiRequest<ExamHeartbeatResultDto>(
          `/student/exams/${examId}/attempts/${attemptId}/heartbeat`,
          {
            method: "POST",
            body: JSON.stringify({
              sequence: nextSeq,
              cameraActive: health.cameraActive,
              screenShareActive: health.screenShareActive,
              fullscreenActive: health.fullscreenActive,
              connectionOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
              clientTimestamp: new Date().toISOString(),
            }),
          },
        );
        pushToast({ title: "Media streams verified" });
      }
    } catch (err) {
      pushToast({
        title: "Cannot resume examination",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Restore camera, screen share, and fullscreen first.",
      });
    } finally {
      setResuming(false);
    }
  };

  const summary = useMemo(() => {
    if (!attempt) {
      return { total: 0, answered: 0, unanswered: 0, marked: 0, unansweredRequired: 0 };
    }
    let answered = 0;
    let marked = 0;
    let unansweredRequired = 0;
    for (const q of attempt.questions) {
      const state = answers[q.id];
      const hasAnswer = isQuestionAnswered(state);
      if (hasAnswer) answered += 1;
      if (state?.markedForReview) marked += 1;
      if (q.isRequired && !hasAnswer) unansweredRequired += 1;
    }
    return {
      total: attempt.questions.length,
      answered,
      unanswered: attempt.questions.length - answered,
      marked,
      unansweredRequired,
    };
  }, [attempt, answers]);

  if (loading) {
    return (
      <div className="space-y-4 py-8">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !attempt) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-10">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Exam attempt could not be loaded."}
        </div>
        <Button asChild variant="outline">
          <Link to="/student/exams">Return to Examinations</Link>
        </Button>
      </div>
    );
  }

  // Terminal / Immutable Receipt View
  if (attempt.isLocked || attempt.receipt) {
    const receipt = attempt.receipt;
    return (
      <div className="mx-auto max-w-3xl space-y-6 py-8">
        <Card>
          <CardHeader className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{attempt.courseCode}</Badge>
              <Badge variant={getAttemptStatusBadgeVariant(attempt.status)}>
                {attempt.status}
              </Badge>
              {attempt.allowUnproctoredDev && (
                <Badge variant="warning">Development Unproctored Mode</Badge>
              )}
            </div>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              Examination Finalized
            </CardTitle>
            <CardDescription>
              {attempt.examTitle} (Attempt #{attempt.attemptNumber} · v{attempt.examVersion})
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {receipt ? (
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                <div>
                  <span className="text-xs text-muted-foreground">Submission Receipt Code</span>
                  <p className="font-mono text-base font-semibold">{receipt.receiptCode}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Finalization Reason</span>
                  <p className="font-medium">{receipt.reason}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Started At</span>
                  <p>{formatDateTimeShort(receipt.startedAt)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Submitted / Locked At</span>
                  <p>{formatDateTimeShort(receipt.submittedAt)}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Questions Answered</span>
                  <p>
                    {receipt.answeredCount} / {receipt.totalQuestions}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Maximum Marks</span>
                  <p>{receipt.totalMarks}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This attempt is locked in {attempt.status} state.
              </p>
            )}

            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              Answers and submission snapshots are locked immutably on the server. Detailed scores and answer feedback are held until institutional results publication (Phase 6).
            </div>

            <Button asChild>
              <Link to="/student/exams">Return to Examinations</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentQuestion = attempt.questions[currentIndex];
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] : undefined;

  return (
    <div className="space-y-4">
      {/* Sticky Top Exam Header */}
      <div className="sticky top-0 z-20 rounded-lg border bg-card p-3 shadow-sm md:p-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{attempt.courseCode}</Badge>
              <Badge variant="outline">Attempt #{attempt.attemptNumber}</Badge>
              {attempt.allowUnproctoredDev && (
                <Badge variant="warning">Development-Only Unproctored Mode</Badge>
              )}
            </div>
            <h1 className="text-lg font-semibold leading-tight">{attempt.examTitle}</h1>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Network & Autosave Indicator */}
            <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
              {isOnline ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-destructive" />
              )}
              <span>
                {!isOnline
                  ? "Offline"
                  : autosaveStatus === "saving"
                    ? "Saving..."
                    : autosaveStatus === "error"
                      ? "Save failed"
                      : autosaveStatus === "saved" && lastSavedLabel
                        ? `Saved ${lastSavedLabel}`
                        : "Server synced"}
              </span>
              {autosaveStatus === "error" && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  onClick={() => void flushPendingSaves()}
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry Save
                </Button>
              )}
            </div>

            {/* Authoritative Server Countdown */}
            <div
              className={`flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-base font-semibold ${
                remainingSeconds <= 60
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : remainingSeconds <= 300
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-border bg-muted/30"
              }`}
              aria-label="Time remaining"
            >
              <Clock className="h-4 w-4" />
              <span>{formatCountdown(remainingSeconds)}</span>
            </div>

            <Button onClick={() => void handleOpenSubmitConfirmation()}>
              <Send className="h-4 w-4" />
              Submit Exam
            </Button>
          </div>
        </div>

        {/* Phase 5 Proctoring Status & Telemetry Bar */}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span>{attempt.preflight.bannerLabel}</span>

          {!attempt.allowUnproctoredDev && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Badge variant={violationCount > 0 ? "destructive" : "outline"}>
                Strikes: {violationCount} / {strikeThreshold}
              </Badge>
              {attempt.policy.requireWebcam && (
                <Badge variant={media.state.cameraActive ? "success" : "destructive"}>
                  <Camera className="mr-1 h-3 w-3" />
                  {media.state.cameraActive ? "Cam Live" : "Cam Off"}
                </Badge>
              )}
              {attempt.policy.requireScreenShare && (
                <Badge variant={media.state.screenShareActive ? "success" : "destructive"}>
                  <Monitor className="mr-1 h-3 w-3" />
                  {media.state.screenShareActive ? "Screen Shared" : "Screen Stopped"}
                </Badge>
              )}
              {attempt.policy.requireFullscreen && (
                <Badge variant={media.state.fullscreenActive ? "success" : "warning"}>
                  <Maximize2 className="mr-1 h-3 w-3" />
                  {media.state.fullscreenActive ? "Fullscreen" : "Exit Fullscreen"}
                </Badge>
              )}
            </div>
          )}

          {autosaveError && <span className="text-destructive">{autosaveError}</span>}
        </div>

        {lockdownNotice && (
          <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
            {lockdownNotice}
          </div>
        )}
      </div>

      {/* Main Split Workspace */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* Left Rail: Question Navigation Palette + Local Webcam Monitor */}
        <div className="lg:col-span-4 xl:col-span-3 space-y-4 h-fit">
          {!attempt.allowUnproctoredDev && attempt.policy.requireWebcam && media.state.cameraStream && (
            <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
              <video
                ref={webcamThumbRef}
                autoPlay
                playsInline
                muted
                aria-label="Active webcam proctoring preview"
                className="aspect-video w-full object-cover"
              />
              <div className="px-2.5 py-1.5 text-[11px] text-muted-foreground text-center border-t">
                Local preview · Not uploaded
              </div>
            </div>
          )}

          <Card>
            <CardHeader className="pb-3">
            <CardTitle className="text-base">Question Palette</CardTitle>
            <CardDescription className="text-xs">
              {summary.answered} answered · {summary.unanswered} remaining · {summary.marked} marked
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-5 gap-2">
              {attempt.questions.map((q, idx) => {
                const state = answers[q.id];
                const answered = isQuestionAnswered(state);
                const marked = Boolean(state?.markedForReview);
                const isCurrent = idx === currentIndex;

                return (
                  <button
                    key={q.id}
                    type="button"
                    aria-label={`Jump to question ${idx + 1}`}
                    onClick={() => setCurrentIndex(idx)}
                    className={`relative flex h-10 items-center justify-center rounded-md border text-sm font-medium transition-colors ${
                      isCurrent
                        ? "border-primary bg-primary text-primary-foreground"
                        : marked
                          ? "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-300"
                          : answered
                            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                            : "border-border bg-background hover:bg-muted"
                    }`}
                  >
                    {idx + 1}
                    {q.isRequired && (
                      <span className="absolute right-1 top-0.5 text-[10px] font-bold">*</span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="space-y-1 text-xs text-muted-foreground border-t pt-3">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded border border-emerald-500/50 bg-emerald-500/15" />
                Answered
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded border border-amber-500/60 bg-amber-500/15" />
                Marked for Review
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded border border-border bg-background" />
                Unanswered (* Required)
              </div>
            </div>
          </CardContent>
        </Card>
        </div>

        {/* Active Question Canvas */}
        <div className="lg:col-span-8 xl:col-span-9">
          {currentQuestion ? (
            <Card>
              <CardHeader className="border-b pb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="default">
                      Question {currentIndex + 1} of {attempt.questions.length}
                    </Badge>
                    <Badge variant="outline">
                      {formatQuestionTypeLabel(currentQuestion.type)}
                    </Badge>
                    <Badge variant="outline">+{currentQuestion.marks} marks</Badge>
                    {currentQuestion.negativeMarks > 0 && (
                      <Badge variant="warning">-{currentQuestion.negativeMarks} penalty</Badge>
                    )}
                    {currentQuestion.isRequired && <Badge variant="destructive">Required</Badge>}
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant={currentAnswer?.markedForReview ? "default" : "outline"}
                    onClick={() => handleToggleMarkForReview(currentQuestion.id)}
                  >
                    <Bookmark className="h-3.5 w-3.5" />
                    {currentAnswer?.markedForReview ? "Marked for Review" : "Mark for Review"}
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="space-y-6 pt-6">
                <div
                  className={`text-base font-medium leading-relaxed whitespace-pre-wrap ${
                    isProctoredActive && attempt.policy.restrictTextSelection ? "select-none" : ""
                  }`}
                >
                  {currentQuestion.prompt}
                </div>

                {!isSubjectiveQuestionType(currentQuestion.type) ? (
                  <div className="space-y-2.5">
                    {currentQuestion.options.map((opt) => {
                      const selected =
                        currentAnswer?.selectedOptionIds.includes(opt.id) ?? false;
                      const isMulti = currentQuestion.type === QuestionType.MULTIPLE_SELECT;

                      return (
                        <label
                          key={opt.id}
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 text-sm transition-colors ${
                            selected
                              ? "border-primary bg-primary/5 font-medium"
                              : "border-border hover:bg-muted/40"
                          }`}
                        >
                          <input
                            type={isMulti ? "checkbox" : "radio"}
                            name={`question-${currentQuestion.id}`}
                            className="mt-1"
                            checked={selected}
                            onChange={() =>
                              isMulti
                                ? handleToggleMultiOption(currentQuestion.id, opt.id)
                                : handleSelectSingleOption(currentQuestion.id, opt.id)
                            }
                          />
                          <span className="font-semibold">{opt.label}.</span>
                          <span className="flex-1">{opt.text}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      aria-label={`Answer for question ${currentIndex + 1}`}
                      rows={currentQuestion.type === QuestionType.SUBJECTIVE_LONG ? 10 : 4}
                      className="w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-relaxed"
                      placeholder="Write your response here. Your answer autosaves directly to the server..."
                      value={currentAnswer?.textAnswer ?? ""}
                      onChange={(e) =>
                        handleTextAnswerChange(currentQuestion.id, e.target.value)
                      }
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {(currentAnswer?.textAnswer ?? "").trim()
                          ? `${(currentAnswer?.textAnswer ?? "").trim().split(/\s+/).length} words`
                          : "0 words"}
                      </span>
                      <span>{(currentAnswer?.textAnswer ?? "").length} characters</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!isQuestionAnswered(currentAnswer)}
                    onClick={() => handleClearResponse(currentQuestion.id)}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                    Clear Response
                  </Button>

                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={currentIndex === 0}
                      onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                    {currentIndex < attempt.questions.length - 1 ? (
                      <Button
                        type="button"
                        onClick={() =>
                          setCurrentIndex((i) => Math.min(attempt.questions.length - 1, i + 1))
                        }
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        onClick={() => void handleOpenSubmitConfirmation()}
                      >
                        <Send className="h-4 w-4" />
                        Review &amp; Submit
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Submission Confirmation Dialog */}
      <Dialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Examination Submission</DialogTitle>
            <DialogDescription>
              Once submitted, your attempt is locked immutably and cannot be modified.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-2 rounded-md border bg-muted/30 p-3 text-center">
              <div>
                <div className="text-lg font-semibold text-emerald-600">{summary.answered}</div>
                <div className="text-xs text-muted-foreground">Answered</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-amber-600">{summary.marked}</div>
                <div className="text-xs text-muted-foreground">Marked</div>
              </div>
              <div>
                <div className="text-lg font-semibold">{summary.unanswered}</div>
                <div className="text-xs text-muted-foreground">Unanswered</div>
              </div>
            </div>

            {summary.unansweredRequired > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {summary.unansweredRequired} required question(s) are still unanswered.
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSubmitDialogOpen(false)}
              >
                Continue Attempt
              </Button>
              <Button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirmSubmit()}
              >
                {submitting ? "Submitting..." : "Confirm Final Submit"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* First-Strike / Integrity Warning Modal (deferred whenever PAUSED recovery overlay is active so dialogs never stack) */}
      <Dialog
        open={warningModal !== null && !recoveryOverlayOpen}
        onOpenChange={(open) => !open && setWarningModal(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-5 w-5" />
              Proctoring Integrity Warning (Strike {warningModal?.strike} of {warningModal?.threshold})
            </DialogTitle>
            <DialogDescription>
              {warningModal?.message}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              Remaining strikes before server-authoritative auto-submission:{" "}
              <strong>{warningModal?.remaining ?? 0}</strong>. One additional counted violation will immediately lock and submit your examination.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setWarningModal(null)}>
                Acknowledge &amp; Continue Examination
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Media / Fullscreen Recovery & Paused Overlay */}
      <Dialog open={recoveryOverlayOpen} onOpenChange={() => {}}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
              <PauseCircle className="h-5 w-5" />
              {attempt.status === "PAUSED"
                ? "Examination Attempt Paused — Media Recovery Required"
                : "Re-Verify Required Proctoring Streams"}
            </DialogTitle>
            <DialogDescription>
              {attempt.pauseReason ??
                "Please restore all required camera, screen sharing, and fullscreen states to continue. Answer autosaving is suspended while paused; your server deadline remains unchanged."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            {violationCount > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                Strike recorded: <strong>{violationCount} of {strikeThreshold}</strong> (
                {Math.max(0, strikeThreshold - violationCount)} remaining before auto-submission).
              </div>
            )}
            <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
              {attempt.policy.requireWebcam && (
                <div className="flex items-center justify-between gap-2">
                  <span>Camera Stream: {media.state.cameraActive ? "Active" : "Missing"}</span>
                  {!media.state.cameraActive && (
                    <Button size="sm" variant="outline" onClick={() => void media.requestCamera()}>
                      Enable Camera
                    </Button>
                  )}
                </div>
              )}
              {attempt.policy.requireScreenShare && (
                <div className="flex items-center justify-between gap-2">
                  <span>Screen Share: {media.state.screenShareActive ? "Active" : "Stopped"}</span>
                  {!media.state.screenShareActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void media.requestScreenShare(attempt.policy.allowedScreenSurface)}
                    >
                      Share Screen
                    </Button>
                  )}
                </div>
              )}
              {attempt.policy.requireFullscreen && (
                <div className="flex items-center justify-between gap-2">
                  <span>Fullscreen: {media.state.fullscreenActive ? "Active" : "Exited"}</span>
                  {!media.state.fullscreenActive && (
                    <Button size="sm" variant="outline" onClick={() => void media.requestFullscreen()}>
                      Enter Fullscreen
                    </Button>
                  )}
                </div>
              )}
            </div>

            {media.state.lastError && (
              <p className="text-xs text-destructive">{media.state.lastError}</p>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                disabled={missingRequiredMedia || resuming}
                onClick={() => void handleResumeProctoredAttempt()}
              >
                {resuming ? "Resuming..." : "Resume Examination"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
