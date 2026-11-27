import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  CopyPlus,
  Download,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  ExamStatus,
  type ExamAttemptSummaryDto,
  type ExamDetailDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import {
  formatDateTimeShort,
  formatQuestionTypeLabel,
  fromDateTimeLocalValue,
  getAttemptStatusBadgeVariant,
  getExamStatusBadgeVariant,
  toDateTimeLocalValue,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type AdminTab = "controls" | "questions" | "attempts";

export function AdminExamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const [exam, setExam] = useState<ExamDetailDto | null>(null);
  const [attempts, setAttempts] = useState<ExamAttemptSummaryDto[]>([]);
  const [tab, setTab] = useState<AdminTab>("controls");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scheduling / Config fields
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [passingMarks, setPassingMarks] = useState("0");
  const [isEnabled, setIsEnabled] = useState(true);
  const [allowUnproctoredDev, setAllowUnproctoredDev] = useState(false);
  const [activateImmediately, setActivateImmediately] = useState(true);
  const [busyAction, setBusyAction] = useState(false);

  // Reject / Cancel dialogs
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const syncForm = (detail: ExamDetailDto) => {
    setWindowStart(toDateTimeLocalValue(detail.windowStart));
    setWindowEnd(toDateTimeLocalValue(detail.windowEnd));
    setDurationMinutes(String(detail.durationMinutes));
    setMaxAttempts(String(detail.maxAttempts));
    setPassingMarks(String(detail.passingMarks));
    setIsEnabled(detail.isEnabled);
    setAllowUnproctoredDev(detail.allowUnproctoredDev);
  };

  const loadExam = useCallback(async (showSkeleton = false) => {
    if (!id) return;
    if (showSkeleton) setLoading(true);
    setError(null);
    try {
      const [detail, attemptList] = await Promise.all([
        apiRequest<ExamDetailDto>(`/admin/exams/${id}`),
        apiRequest<ExamAttemptSummaryDto[]>(`/admin/exams/${id}/attempts`),
      ]);
      setExam(detail);
      setAttempts(attemptList);
      syncForm(detail);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load examination details.");
    } finally {
      if (showSkeleton) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadExam(true);
  }, [loadExam]);

  const handleApprove = async () => {
    if (!exam) return;
    setBusyAction(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/admin/exams/${exam.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          windowStart: fromDateTimeLocalValue(windowStart),
          windowEnd: fromDateTimeLocalValue(windowEnd),
          durationMinutes: Number(durationMinutes),
          maxAttempts: Number(maxAttempts),
          passingMarks: Number(passingMarks),
          allowUnproctoredDev,
          activateImmediately,
        }),
      });
      setExam(updated);
      syncForm(updated);
      pushToast({
        title: activateImmediately ? "Exam approved and activated" : "Exam approved",
        description: allowUnproctoredDev
          ? "Development-only unproctored delivery enabled."
          : "Mandatory Phase 5 proctoring remains enforced.",
      });
    } catch (err) {
      pushToast({
        title: "Approval failed",
        description: err instanceof ApiClientError ? err.message : "Check exam values.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exam) return;
    setBusyAction(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/admin/exams/${exam.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      setExam(updated);
      setRejectOpen(false);
      setRejectReason("");
      pushToast({ title: "Examination rejected", description: "Returned to teacher with feedback." });
    } catch (err) {
      pushToast({
        title: "Rejection failed",
        description: err instanceof ApiClientError ? err.message : "Provide a valid reason.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exam) return;
    setBusyAction(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/admin/exams/${exam.id}/config`, {
        method: "PATCH",
        body: JSON.stringify({
          windowStart: fromDateTimeLocalValue(windowStart),
          windowEnd: fromDateTimeLocalValue(windowEnd),
          durationMinutes: Number(durationMinutes),
          maxAttempts: Number(maxAttempts),
          passingMarks: Number(passingMarks),
          isEnabled,
          allowUnproctoredDev,
        }),
      });
      setExam(updated);
      syncForm(updated);
      pushToast({ title: "Configuration updated" });
    } catch (err) {
      pushToast({
        title: "Update failed",
        description: err instanceof ApiClientError ? err.message : "Invalid configuration.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleLifecycleAction = async (action: "activate" | "pause") => {
    if (!exam) return;
    setBusyAction(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/admin/exams/${exam.id}/${action}`, {
        method: "POST",
      });
      setExam(updated);
      syncForm(updated);
      pushToast({
        title: action === "activate" ? "Examination activated" : "Examination paused",
      });
    } catch (err) {
      pushToast({
        title: "Action failed",
        description: err instanceof ApiClientError ? err.message : "Invalid state transition.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleCancelExam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exam) return;
    setBusyAction(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/admin/exams/${exam.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: cancelReason.trim() }),
      });
      setExam(updated);
      setCancelOpen(false);
      setCancelReason("");
      await loadExam();
      pushToast({
        title: "Examination cancelled",
        description: "Ongoing active attempts have been terminated atomically.",
      });
    } catch (err) {
      pushToast({
        title: "Cancellation failed",
        description: err instanceof ApiClientError ? err.message : "Provide cancellation reason.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleCreateVersion = async () => {
    if (!exam) return;
    setBusyAction(true);
    try {
      const versioned = await apiRequest<ExamDetailDto>(
        `/admin/exams/${exam.id}/create-version`,
        { method: "POST", body: JSON.stringify({}) },
      );
      pushToast({
        title: `Created Version v${versioned.version}`,
        description: "Historical attempts stay pinned to the prior version.",
      });
      navigate(`/admin/exams/${versioned.id}`);
    } catch (err) {
      pushToast({
        title: "Versioning failed",
        description: err instanceof ApiClientError ? err.message : "Could not create new version.",
      });
    } finally {
      setBusyAction(false);
    }
  };

  const handleForceTerminate = async (attemptId: string) => {
    if (!exam) return;
    try {
      await apiRequest(`/admin/exams/${exam.id}/attempts/${attemptId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "Terminated by administrator" }),
      });
      pushToast({ title: "Attempt terminated and finalized" });
      await loadExam();
    } catch (err) {
      pushToast({
        title: "Termination failed",
        description: err instanceof ApiClientError ? err.message : "Could not terminate attempt.",
      });
    }
  };

  const handleExport = async (format: "csv" | "json") => {
    if (!exam) return;
    try {
      const response = await fetch(`/api/v1/admin/exams/${exam.id}/questions/export?format=${format}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `exam-${exam.id}-questions.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      pushToast({ title: "Export failed" });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/exams">
            <ArrowLeft className="h-4 w-4" />
            Back to Examinations
          </Link>
        </Button>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Examination not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="space-y-1.5">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/admin/exams">
              <ArrowLeft className="h-4 w-4" />
              Back to Control Center
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{exam.courseCode}</Badge>
            <Badge variant={getExamStatusBadgeVariant(exam.status)}>{exam.status}</Badge>
            <Badge variant="outline">v{exam.version}</Badge>
            {exam.allowUnproctoredDev ? (
              <Badge variant="warning">Development Unproctored</Badge>
            ) : (
              <Badge variant="outline">Phase 5 Proctoring Required</Badge>
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{exam.title}</h1>
          <p className="text-sm text-muted-foreground">
            {exam.courseTitle} · Instructor: {exam.teacherName} · {exam.questions.length} questions ·{" "}
            {exam.totalMarks} marks
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleExport("csv")}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleCreateVersion()} disabled={busyAction}>
            <CopyPlus className="h-4 w-4" />
            Create Version v{exam.version + 1}
          </Button>
        </div>
      </div>

      {/* Phase 5 Proctoring Preflight Banner */}
      <Card
        className={
          exam.preflight.canStartAttempt
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-primary/30 bg-primary/5"
        }
      >
        <CardContent className="flex items-start gap-3 pt-5 text-sm">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-medium">
              Preflight Mode: {exam.preflight.mode} — {exam.preflight.bannerLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              {exam.preflight.canStartAttempt && exam.allowUnproctoredDev
                ? "Admin has enabled development-only unproctored delivery for local testing (automatically rejected in production)."
                : exam.preflight.blockingMessage ??
                  `Students must pass preflight checks (Camera: ${exam.preflight.requirements.requireWebcam ? "On" : "Off"}, Screen Share: ${exam.preflight.requirements.requireScreenShare ? "On" : "Off"}, Threshold: ${exam.preflight.requirements.violationThreshold} strikes).`}
            </p>
            <div className="pt-1">
              <Button asChild size="sm" variant="outline">
                <Link to={`/admin/proctoring?examId=${exam.id}`}>
                  Configure Exam Proctoring Policy &amp; Monitor
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2 border-b pb-3">
        {(
          [
            ["controls", "Approval & Scheduling"],
            ["questions", `Questions & Keys (${exam.questions.length})`],
            ["attempts", `Attempts & Submissions (${attempts.length})`],
          ] as Array<[AdminTab, string]>
        ).map(([key, label]) => (
          <Button
            key={key}
            variant={tab === key ? "default" : "outline"}
            size="sm"
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {tab === "controls" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <CardHeader>
              <CardTitle>Scheduling &amp; Delivery Configuration</CardTitle>
              <CardDescription>
                Control authoritative start/end availability window, duration, attempt limit, enable state, and unproctored Phase 4 toggle.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void handleSaveConfig(e)} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-start">Window Start</Label>
                    <Input
                      id="adm-start"
                      type="datetime-local"
                      value={windowStart}
                      onChange={(e) => setWindowStart(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-end">Window End</Label>
                    <Input
                      id="adm-end"
                      type="datetime-local"
                      value={windowEnd}
                      onChange={(e) => setWindowEnd(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-duration">Duration (min)</Label>
                    <Input
                      id="adm-duration"
                      type="number"
                      min={1}
                      max={600}
                      value={durationMinutes}
                      onChange={(e) => setDurationMinutes(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-attempts">Max Attempts</Label>
                    <Input
                      id="adm-attempts"
                      type="number"
                      min={1}
                      max={10}
                      value={maxAttempts}
                      onChange={(e) => setMaxAttempts(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="adm-passing">Passing Marks</Label>
                    <Input
                      id="adm-passing"
                      type="number"
                      min={0}
                      step="0.5"
                      value={passingMarks}
                      onChange={(e) => setPassingMarks(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="space-y-2 rounded-md border p-3 text-sm">
                  <label className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={isEnabled}
                      onChange={(e) => setIsEnabled(e.target.checked)}
                    />
                    Exam Enabled (students may enter during active window)
                  </label>

                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={allowUnproctoredDev}
                      onChange={(e) => setAllowUnproctoredDev(e.target.checked)}
                    />
                    <span>
                      <strong>Enable Development-Only Unproctored Delivery</strong>
                      <span className="block text-xs text-muted-foreground">
                        When unchecked, exam starts are blocked with PROCTORING_UNAVAILABLE until Phase 5 proctoring is implemented.
                      </span>
                    </span>
                  </label>
                </div>

                {exam.status === ExamStatus.PENDING_APPROVAL ? (
                  <div className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-4">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={activateImmediately}
                        onChange={(e) => setActivateImmediately(e.target.checked)}
                      />
                      Activate exam immediately upon approval
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void handleApprove()}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Approve Examination
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={busyAction}
                        onClick={() => setRejectOpen(true)}
                      >
                        <XCircle className="h-4 w-4" />
                        Reject with Reason
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      disabled={
                        busyAction ||
                        exam.status === ExamStatus.CANCELLED ||
                        exam.status === ExamStatus.ARCHIVED
                      }
                    >
                      Save Configuration
                    </Button>
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          <Card className="lg:col-span-4">
            <CardHeader>
              <CardTitle>Lifecycle Controls</CardTitle>
              <CardDescription>
                Audited state transitions and emergency controls.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(exam.status === ExamStatus.APPROVED || exam.status === ExamStatus.PAUSED) && (
                <Button
                  className="w-full"
                  disabled={busyAction}
                  onClick={() => void handleLifecycleAction("activate")}
                >
                  <PlayCircle className="h-4 w-4" />
                  Activate Examination
                </Button>
              )}

              {exam.status === ExamStatus.ACTIVE && (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={busyAction}
                  onClick={() => void handleLifecycleAction("pause")}
                >
                  <PauseCircle className="h-4 w-4" />
                  Pause New Starts
                </Button>
              )}

              {exam.status !== ExamStatus.CANCELLED && exam.status !== ExamStatus.ARCHIVED && (
                <Button
                  variant="destructive"
                  className="w-full"
                  disabled={busyAction}
                  onClick={() => setCancelOpen(true)}
                >
                  <Ban className="h-4 w-4" />
                  Cancel Examination
                </Button>
              )}

              <div className="space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
                <div>Submitted: {formatDateTimeShort(exam.submittedForApprovalAt)}</div>
                <div>Approved: {formatDateTimeShort(exam.approvedAt)}</div>
                <div>Activated: {formatDateTimeShort(exam.activatedAt)}</div>
                <div>Paused: {formatDateTimeShort(exam.pausedAt)}</div>
                <div>Cancelled: {formatDateTimeShort(exam.cancelledAt)}</div>
                {exam.cancellationReason && (
                  <div className="text-destructive">
                    Cancellation: {exam.cancellationReason}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "questions" && (
        <Card>
          <CardHeader>
            <CardTitle>Question Bank Review ({exam.questions.length} questions)</CardTitle>
            <CardDescription>
              Full answer keys and explanations visible strictly to authorized administrators and course teachers.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {exam.questions.map((q) => (
              <div key={q.id} className="space-y-2 rounded-md border p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">Q{q.orderIndex}</Badge>
                  <Badge variant="default">{formatQuestionTypeLabel(q.type)}</Badge>
                  <Badge variant="outline">+{q.marks}m</Badge>
                  {q.negativeMarks > 0 && <Badge variant="warning">-{q.negativeMarks}m</Badge>}
                </div>
                <p className="font-medium whitespace-pre-wrap">{q.prompt}</p>
                {q.options.length > 0 && (
                  <ul className="space-y-1">
                    {q.options.map((opt) => (
                      <li
                        key={opt.id}
                        className={`rounded border px-2.5 py-1 text-xs ${
                          opt.isCorrect ? "border-emerald-500/40 bg-emerald-500/10 font-medium" : ""
                        }`}
                      >
                        {opt.label}. {opt.text} {opt.isCorrect ? " (Correct)" : ""}
                      </li>
                    ))}
                  </ul>
                )}
                {q.explanation && (
                  <p className="text-xs text-muted-foreground">Explanation: {q.explanation}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === "attempts" && (
        <Card>
          <CardHeader>
            <CardTitle>Participation &amp; Attempts</CardTitle>
            <CardDescription>
              Monitor active and completed exam attempts across enrolled candidates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {attempts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No attempts started yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Candidate</th>
                      <th className="py-2 pr-3">Attempt</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Answered</th>
                      <th className="py-2 pr-3">Receipt</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.map((a) => (
                      <tr key={a.id} className="border-b last:border-0">
                        <td className="py-2.5 pr-3">
                          <div className="font-medium">{a.student.fullName}</div>
                          <div className="text-xs text-muted-foreground">{a.student.email}</div>
                        </td>
                        <td className="py-2.5 pr-3 text-xs">
                          #{a.attemptNumber} (v{a.examVersion})
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge variant={getAttemptStatusBadgeVariant(a.status)}>
                            {a.status}
                          </Badge>
                        </td>
                        <td className="py-2.5 pr-3 text-xs">
                          {a.answeredCount} / {a.questionCount}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs">{a.receiptCode ?? "—"}</td>
                        <td className="py-2.5">
                          {(a.status === "IN_PROGRESS" || a.status === "PAUSED") && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void handleForceTerminate(a.id)}
                            >
                              Terminate
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Examination</DialogTitle>
            <DialogDescription>
              Provide clear feedback explaining why this exam is being returned to the teacher.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleReject(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason">Rejection Reason</Label>
              <textarea
                id="reject-reason"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                required
                minLength={5}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRejectOpen(false)}>
                Close
              </Button>
              <Button type="submit" variant="destructive" disabled={busyAction}>
                Confirm Reject
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Cancel Examination
            </DialogTitle>
            <DialogDescription>
              Cancelling disables new starts and atomically finalizes any currently active student attempts as terminated.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleCancelExam(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reason">Cancellation Reason</Label>
              <textarea
                id="cancel-reason"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
                minLength={5}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCancelOpen(false)}>
                Keep Exam
              </Button>
              <Button type="submit" variant="destructive" disabled={busyAction}>
                Cancel Examination
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
