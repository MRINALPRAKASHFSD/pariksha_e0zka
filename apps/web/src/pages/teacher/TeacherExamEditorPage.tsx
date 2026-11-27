import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FileUp,
  GripVertical,
  Lock,
  Plus,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import {
  ExamStatus,
  QuestionType,
  isSubjectiveQuestionType,
  type ExamAttemptSummaryDto,
  type ExamDetailDto,
  type IntegrityEventDto,
  type QuestionDto,
  type QuestionImportResultDto,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type EditorTab = "settings" | "questions" | "import" | "preview" | "attempts" | "integrity";

interface OptionDraft {
  text: string;
  isCorrect: boolean;
}

function defaultOptionsForType(type: QuestionType): OptionDraft[] {
  if (type === QuestionType.TRUE_FALSE) {
    return [
      { text: "True", isCorrect: true },
      { text: "False", isCorrect: false },
    ];
  }
  if (isSubjectiveQuestionType(type)) {
    return [];
  }
  return [
    { text: "", isCorrect: true },
    { text: "", isCorrect: false },
    { text: "", isCorrect: false },
    { text: "", isCorrect: false },
  ];
}

export function TeacherExamEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const [exam, setExam] = useState<ExamDetailDto | null>(null);
  const [attempts, setAttempts] = useState<ExamAttemptSummaryDto[]>([]);
  const [integrityEvents, setIntegrityEvents] = useState<IntegrityEventDto[]>([]);
  const [tab, setTab] = useState<EditorTab>("questions");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Settings form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [passingMarks, setPassingMarks] = useState("0");
  const [maxAttempts, setMaxAttempts] = useState("1");
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [shuffleQuestions, setShuffleQuestions] = useState(false);
  const [shuffleOptions, setShuffleOptions] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Question builder form state
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [qType, setQType] = useState<QuestionType>(QuestionType.MULTIPLE_CHOICE);
  const [qPrompt, setQPrompt] = useState("");
  const [qExplanation, setQExplanation] = useState("");
  const [qMarks, setQMarks] = useState("2");
  const [qNegativeMarks, setQNegativeMarks] = useState("0");
  const [qRequired, setQRequired] = useState(false);
  const [qOptions, setQOptions] = useState<OptionDraft[]>(defaultOptionsForType(QuestionType.MULTIPLE_CHOICE));
  const [savingQuestion, setSavingQuestion] = useState(false);
  const [draggedQuestionId, setDraggedQuestionId] = useState<string | null>(null);

  // Import state
  const [importFormat, setImportFormat] = useState<"csv" | "json">("csv");
  const [importContent, setImportContent] = useState("");
  const [importPreview, setImportPreview] = useState<QuestionImportResultDto | null>(null);
  const [importing, setImporting] = useState(false);

  const [submittingApproval, setSubmittingApproval] = useState(false);

  const syncSettingsFromExam = (detail: ExamDetailDto) => {
    setTitle(detail.title);
    setDescription(detail.description ?? "");
    setInstructions(detail.instructions ?? "");
    setDurationMinutes(String(detail.durationMinutes));
    setPassingMarks(String(detail.passingMarks));
    setMaxAttempts(String(detail.maxAttempts));
    setWindowStart(toDateTimeLocalValue(detail.windowStart));
    setWindowEnd(toDateTimeLocalValue(detail.windowEnd));
    setShuffleQuestions(detail.shuffleQuestions);
    setShuffleOptions(detail.shuffleOptions);
  };

  const loadExam = useCallback(async (showSkeleton = false) => {
    if (!id) return;
    if (showSkeleton) setLoading(true);
    setError(null);
    try {
      const [detail, attemptList, integrityEventsList] = await Promise.all([
        apiRequest<ExamDetailDto>(`/teacher/exams/${id}`),
        apiRequest<ExamAttemptSummaryDto[]>(`/teacher/exams/${id}/attempts`),
        apiRequest<IntegrityEventDto[]>(`/teacher/exams/${id}/integrity-events`),
      ]);
      setExam(detail);
      setAttempts(attemptList);
      setIntegrityEvents(integrityEventsList);
      syncSettingsFromExam(detail);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load examination.");
    } finally {
      if (showSkeleton) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadExam(true);
  }, [loadExam]);

  const isEditable =
    exam !== null &&
    (exam.status === ExamStatus.DRAFT || exam.status === ExamStatus.REJECTED) &&
    exam.attemptCount === 0;

  const resetQuestionForm = (nextType: QuestionType = QuestionType.MULTIPLE_CHOICE) => {
    setEditingQuestionId(null);
    setQType(nextType);
    setQPrompt("");
    setQExplanation("");
    setQMarks("2");
    setQNegativeMarks("0");
    setQRequired(false);
    setQOptions(defaultOptionsForType(nextType));
  };

  const handleLoadQuestionForEdit = (q: QuestionDto) => {
    setEditingQuestionId(q.id);
    setQType(q.type);
    setQPrompt(q.prompt);
    setQExplanation(q.explanation ?? "");
    setQMarks(String(q.marks));
    setQNegativeMarks(String(q.negativeMarks));
    setQRequired(q.isRequired);
    setQOptions(
      isSubjectiveQuestionType(q.type)
        ? []
        : q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })),
    );
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exam) return;
    setSavingSettings(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(`/teacher/exams/${exam.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          instructions: instructions.trim() || null,
          durationMinutes: Number(durationMinutes),
          passingMarks: Number(passingMarks),
          maxAttempts: Number(maxAttempts),
          windowStart: fromDateTimeLocalValue(windowStart),
          windowEnd: fromDateTimeLocalValue(windowEnd),
          shuffleQuestions,
          shuffleOptions,
        }),
      });
      setExam(updated);
      syncSettingsFromExam(updated);
      pushToast({ title: "Exam settings saved" });
    } catch (err) {
      pushToast({
        title: "Save failed",
        description: err instanceof ApiClientError ? err.message : "Could not save settings.",
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exam) return;
    setSavingQuestion(true);
    try {
      const payload = {
        type: qType,
        prompt: qPrompt.trim(),
        explanation: qExplanation.trim() || null,
        marks: Number(qMarks),
        negativeMarks: Number(qNegativeMarks),
        isRequired: qRequired,
        options: isSubjectiveQuestionType(qType)
          ? []
          : qOptions.map((o, idx) => ({
              label: String.fromCharCode(65 + idx),
              text: o.text.trim(),
              isCorrect: o.isCorrect,
            })),
      };

      if (editingQuestionId) {
        await apiRequest(`/teacher/exams/${exam.id}/questions/${editingQuestionId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        pushToast({ title: "Question updated" });
      } else {
        await apiRequest(`/teacher/exams/${exam.id}/questions`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        pushToast({ title: "Question added to exam" });
      }

      resetQuestionForm(qType);
      await loadExam();
    } catch (err) {
      pushToast({
        title: "Question validation error",
        description: err instanceof ApiClientError ? err.message : "Invalid question configuration.",
      });
    } finally {
      setSavingQuestion(false);
    }
  };

  const handleReorder = async (newIds: string[]) => {
    if (!exam || !isEditable) return;
    try {
      await apiRequest(`/teacher/exams/${exam.id}/questions/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ questionIds: newIds }),
      });
      await loadExam();
    } catch (err) {
      pushToast({
        title: "Reorder failed",
        description: err instanceof ApiClientError ? err.message : "Could not reorder questions.",
      });
    }
  };

  const handleMoveQuestion = (index: number, direction: -1 | 1) => {
    if (!exam) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= exam.questions.length) return;
    const ids = exam.questions.map((q) => q.id);
    const tmp = ids[index]!;
    ids[index] = ids[targetIndex]!;
    ids[targetIndex] = tmp;
    void handleReorder(ids);
  };

  const handleDuplicateQuestion = async (questionId: string) => {
    if (!exam) return;
    try {
      await apiRequest(`/teacher/exams/${exam.id}/questions/${questionId}/duplicate`, {
        method: "POST",
      });
      pushToast({ title: "Question duplicated" });
      await loadExam();
    } catch (err) {
      pushToast({
        title: "Duplicate failed",
        description: err instanceof ApiClientError ? err.message : "Error duplicating question.",
      });
    }
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!exam) return;
    try {
      await apiRequest(`/teacher/exams/${exam.id}/questions/${questionId}`, {
        method: "DELETE",
      });
      if (editingQuestionId === questionId) {
        resetQuestionForm();
      }
      pushToast({ title: "Question removed" });
      await loadExam();
    } catch (err) {
      pushToast({
        title: "Delete failed",
        description: err instanceof ApiClientError ? err.message : "Error removing question.",
      });
    }
  };

  const handleDownloadFile = async (urlPath: string, filename: string) => {
    try {
      const response = await fetch(`/api/v1${urlPath}`, { credentials: "include" });
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      pushToast({ title: "Download failed" });
    }
  };

  const handleImportPreviewOrCommit = async (mode: "preview" | "import") => {
    if (!exam) return;
    setImporting(true);
    try {
      const result = await apiRequest<QuestionImportResultDto>(
        `/teacher/exams/${exam.id}/questions/import`,
        {
          method: "POST",
          body: JSON.stringify({
            format: importFormat,
            content: importContent,
            mode,
          }),
        },
      );
      setImportPreview(result);
      if (mode === "import") {
        pushToast({
          title: "Questions imported",
          description: `Added ${result.importedCount} questions (Total marks: ${result.examTotalMarks}).`,
        });
        setImportContent("");
        await loadExam();
      }
    } catch (err) {
      pushToast({
        title: mode === "preview" ? "Parse error" : "Import failed",
        description: err instanceof ApiClientError ? err.message : "Invalid import payload.",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleSubmitForApproval = async () => {
    if (!exam) return;
    setSubmittingApproval(true);
    try {
      const updated = await apiRequest<ExamDetailDto>(
        `/teacher/exams/${exam.id}/submit-for-approval`,
        { method: "POST" },
      );
      setExam(updated);
      pushToast({
        title: "Submitted for administrative approval",
        description: "An institutional admin can now review, schedule, and activate this exam.",
      });
    } catch (err) {
      pushToast({
        title: "Cannot submit for approval",
        description: err instanceof ApiClientError ? err.message : "Check exam requirements.",
      });
    } finally {
      setSubmittingApproval(false);
    }
  };

  const handleDuplicateExam = async () => {
    if (!exam) return;
    try {
      const copy = await apiRequest<ExamDetailDto>(`/teacher/exams/${exam.id}/duplicate`, {
        method: "POST",
      });
      pushToast({ title: "Draft duplicated", description: copy.title });
      navigate(`/teacher/exams/${copy.id}`);
    } catch (err) {
      pushToast({
        title: "Duplicate failed",
        description: err instanceof ApiClientError ? err.message : "Error duplicating exam.",
      });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !exam) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/teacher/exams">
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
            <Link to="/teacher/exams">
              <ArrowLeft className="h-4 w-4" />
              Back to Examinations
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{exam.courseCode}</Badge>
            <Badge variant={getExamStatusBadgeVariant(exam.status)}>{exam.status}</Badge>
            <Badge variant="outline">v{exam.version}</Badge>
            <Badge variant="default">Total Marks: {exam.totalMarks}</Badge>
            <Badge variant="outline">Passing: {exam.passingMarks}</Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{exam.title}</h1>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void handleDownloadFile(
                `/teacher/exams/${exam.id}/questions/export?format=csv`,
                `exam-${exam.id}-questions.csv`,
              )
            }
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleDuplicateExam()}>
            <Copy className="h-4 w-4" />
            Duplicate Draft
          </Button>
          {isEditable && (
            <Button
              size="sm"
              disabled={submittingApproval}
              onClick={() => void handleSubmitForApproval()}
            >
              <Send className="h-4 w-4" />
              {submittingApproval ? "Submitting..." : "Submit for Approval"}
            </Button>
          )}
        </div>
      </div>

      {!isEditable && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            This examination is in <strong>{exam.status}</strong> status
            {exam.attemptCount > 0 ? ` with ${exam.attemptCount} student attempt(s)` : ""} and is read-only. Duplicate it or ask an admin to create a new version for future edits.
          </span>
        </div>
      )}

      {exam.status === ExamStatus.REJECTED && exam.rejectionReason && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <strong>Admin Rejection Reason:</strong> {exam.rejectionReason} — Update the exam and resubmit for approval.
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-3">
        {(
          [
            ["questions", `Question Builder (${exam.questions.length})`],
            ["import", "CSV / JSON Import"],
            ["settings", "Exam Settings"],
            ["preview", "Student Preview"],
            ["attempts", `Attempts & Submissions (${attempts.length})`],
            ["integrity", `Integrity Events (${integrityEvents.length})`],
          ] as Array<[EditorTab, string]>
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

      {tab === "settings" && (
        <Card>
          <CardHeader>
            <CardTitle>Examination Settings</CardTitle>
            <CardDescription>
              Proposed availability window and rules; institutional administrators approve final schedule and proctoring delivery.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleSaveSettings(e)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-title">Title</Label>
                <Input
                  id="edit-title"
                  value={title}
                  disabled={!isEditable}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-duration">Duration (minutes)</Label>
                  <Input
                    id="edit-duration"
                    type="number"
                    min={1}
                    max={600}
                    disabled={!isEditable}
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-passing">Passing Marks (Total: {exam.totalMarks})</Label>
                  <Input
                    id="edit-passing"
                    type="number"
                    min={0}
                    step="0.5"
                    disabled={!isEditable}
                    value={passingMarks}
                    onChange={(e) => setPassingMarks(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-max-attempts">Max Attempts</Label>
                  <Input
                    id="edit-max-attempts"
                    type="number"
                    min={1}
                    max={10}
                    disabled={!isEditable}
                    value={maxAttempts}
                    onChange={(e) => setMaxAttempts(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-start">Window Start</Label>
                  <Input
                    id="edit-start"
                    type="datetime-local"
                    disabled={!isEditable}
                    value={windowStart}
                    onChange={(e) => setWindowStart(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-end">Window End</Label>
                  <Input
                    id="edit-end"
                    type="datetime-local"
                    disabled={!isEditable}
                    value={windowEnd}
                    onChange={(e) => setWindowEnd(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-desc">Description</Label>
                <textarea
                  id="edit-desc"
                  rows={2}
                  disabled={!isEditable}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="edit-inst">Candidate Instructions</Label>
                <textarea
                  id="edit-inst"
                  rows={3}
                  disabled={!isEditable}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </div>

              <div className="flex flex-wrap gap-6 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!isEditable}
                    checked={shuffleQuestions}
                    onChange={(e) => setShuffleQuestions(e.target.checked)}
                  />
                  Shuffle question order
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!isEditable}
                    checked={shuffleOptions}
                    onChange={(e) => setShuffleOptions(e.target.checked)}
                  />
                  Shuffle option order
                </label>
              </div>

              {isEditable && (
                <div className="flex justify-end">
                  <Button type="submit" disabled={savingSettings}>
                    {savingSettings ? "Saving..." : "Save Settings"}
                  </Button>
                </div>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {tab === "questions" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-3 lg:col-span-7">
            <h2 className="text-lg font-semibold">
              Questions ({exam.questions.length}) · Total {exam.totalMarks} marks
            </h2>
            {exam.questions.length === 0 ? (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  No questions added yet. Create a question using the builder panel or import from CSV/JSON.
                </CardContent>
              </Card>
            ) : (
              exam.questions.map((q, idx) => (
                <Card
                  key={q.id}
                  draggable={isEditable}
                  onDragStart={() => setDraggedQuestionId(q.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (!isEditable || !draggedQuestionId || draggedQuestionId === q.id) return;
                    const ids = exam.questions.map((item) => item.id);
                    const fromIdx = ids.indexOf(draggedQuestionId);
                    const toIdx = ids.indexOf(q.id);
                    if (fromIdx < 0 || toIdx < 0) return;
                    ids.splice(fromIdx, 1);
                    ids.splice(toIdx, 0, draggedQuestionId);
                    setDraggedQuestionId(null);
                    void handleReorder(ids);
                  }}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {isEditable && (
                          <GripVertical className="h-4 w-4 cursor-grab text-muted-foreground" />
                        )}
                        <Badge variant="outline">Q{q.orderIndex}</Badge>
                        <Badge variant="default">{formatQuestionTypeLabel(q.type)}</Badge>
                        <Badge variant="outline">+{q.marks}m</Badge>
                        {q.negativeMarks > 0 && (
                          <Badge variant="warning">-{q.negativeMarks}m</Badge>
                        )}
                        {q.isRequired && <Badge variant="outline">Required</Badge>}
                      </div>

                      {isEditable && (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move question ${q.orderIndex} up`}
                            disabled={idx === 0}
                            onClick={() => handleMoveQuestion(idx, -1)}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Move question ${q.orderIndex} down`}
                            disabled={idx === exam.questions.length - 1}
                            onClick={() => handleMoveQuestion(idx, 1)}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleLoadQuestionForEdit(q)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Duplicate question ${q.orderIndex}`}
                            onClick={() => void handleDuplicateQuestion(q.id)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete question ${q.orderIndex}`}
                            onClick={() => void handleDeleteQuestion(q.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="font-medium whitespace-pre-wrap">{q.prompt}</p>
                    {q.options.length > 0 && (
                      <ul className="space-y-1">
                        {q.options.map((opt) => (
                          <li
                            key={opt.id}
                            className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs ${
                              opt.isCorrect
                                ? "border-emerald-500/40 bg-emerald-500/10 font-medium"
                                : "border-border"
                            }`}
                          >
                            <span className="font-semibold">{opt.label}.</span>
                            <span className="flex-1">{opt.text}</span>
                            {opt.isCorrect && (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {q.explanation && (
                      <p className="text-xs text-muted-foreground">
                        <strong>Explanation:</strong> {q.explanation}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          <div className="lg:col-span-5">
            <Card className="sticky top-4">
              <CardHeader>
                <CardTitle>
                  {editingQuestionId ? "Edit Question" : "Add Question"}
                </CardTitle>
                <CardDescription>
                  Server validates answer keys and recalculates total exam marks automatically.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!isEditable ? (
                  <p className="text-sm text-muted-foreground">
                    Question creation and editing are locked because the exam is no longer an editable draft.
                  </p>
                ) : (
                  <form onSubmit={(e) => void handleSaveQuestion(e)} className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="q-type">Question Type</Label>
                      <select
                        id="q-type"
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={qType}
                        onChange={(e) => {
                          const next = e.target.value as QuestionType;
                          setQType(next);
                          if (next === QuestionType.TRUE_FALSE) {
                            setQOptions(defaultOptionsForType(QuestionType.TRUE_FALSE));
                          } else if (isSubjectiveQuestionType(next)) {
                            setQOptions([]);
                          } else if (qOptions.length < 2) {
                            setQOptions(defaultOptionsForType(next));
                          } else if (next === QuestionType.MULTIPLE_CHOICE) {
                            let seenCorrect = false;
                            setQOptions(
                              qOptions.map((o) => {
                                if (o.isCorrect && !seenCorrect) {
                                  seenCorrect = true;
                                  return o;
                                }
                                return { ...o, isCorrect: false };
                              }),
                            );
                          }
                        }}
                      >
                        <option value={QuestionType.MULTIPLE_CHOICE}>Multiple Choice (Single Correct)</option>
                        <option value={QuestionType.MULTIPLE_SELECT}>Multiple Select (Multi-Correct)</option>
                        <option value={QuestionType.TRUE_FALSE}>True / False</option>
                        <option value={QuestionType.SUBJECTIVE_SHORT}>Subjective Short Answer</option>
                        <option value={QuestionType.SUBJECTIVE_LONG}>Subjective Long Answer</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="q-prompt">Question Prompt</Label>
                      <textarea
                        id="q-prompt"
                        rows={3}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={qPrompt}
                        onChange={(e) => setQPrompt(e.target.value)}
                        placeholder="Enter question statement..."
                        required
                      />
                    </div>

                    <div className="grid gap-3 grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="q-marks">Marks</Label>
                        <Input
                          id="q-marks"
                          type="number"
                          step="0.5"
                          min="0.5"
                          value={qMarks}
                          onChange={(e) => setQMarks(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="q-neg-marks">Negative Marks</Label>
                        <Input
                          id="q-neg-marks"
                          type="number"
                          step="0.25"
                          min="0"
                          value={qNegativeMarks}
                          onChange={(e) => setQNegativeMarks(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={qRequired}
                        onChange={(e) => setQRequired(e.target.checked)}
                      />
                      Mark question as required
                    </label>

                    {!isSubjectiveQuestionType(qType) && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>
                            Options ({qType === QuestionType.MULTIPLE_SELECT ? "Check all correct" : "Select one correct"})
                          </Label>
                          {qType !== QuestionType.TRUE_FALSE && qOptions.length < 10 && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setQOptions((prev) => [...prev, { text: "", isCorrect: false }])
                              }
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Option
                            </Button>
                          )}
                        </div>

                        <div className="space-y-2">
                          {qOptions.map((opt, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <input
                                type={qType === QuestionType.MULTIPLE_SELECT ? "checkbox" : "radio"}
                                name="correct-option-group"
                                aria-label={`Mark option ${String.fromCharCode(65 + idx)} correct`}
                                checked={opt.isCorrect}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setQOptions((prev) =>
                                    prev.map((item, i) => {
                                      if (qType === QuestionType.MULTIPLE_SELECT) {
                                        return i === idx ? { ...item, isCorrect: checked } : item;
                                      }
                                      return { ...item, isCorrect: i === idx };
                                    }),
                                  );
                                }}
                              />
                              <span className="w-5 text-xs font-semibold">
                                {String.fromCharCode(65 + idx)}
                              </span>
                              <Input
                                value={opt.text}
                                readOnly={qType === QuestionType.TRUE_FALSE}
                                placeholder={`Option ${String.fromCharCode(65 + idx)}`}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setQOptions((prev) =>
                                    prev.map((item, i) => (i === idx ? { ...item, text: val } : item)),
                                  );
                                }}
                                required
                              />
                              {qType !== QuestionType.TRUE_FALSE && qOptions.length > 2 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Remove option ${String.fromCharCode(65 + idx)}`}
                                  onClick={() =>
                                    setQOptions((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="q-explanation">Answer Explanation / Rubric (Teacher &amp; Review Only)</Label>
                      <textarea
                        id="q-explanation"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={qExplanation}
                        onChange={(e) => setQExplanation(e.target.value)}
                        placeholder="Hidden from students during examination"
                      />
                    </div>

                    <div className="flex justify-end gap-2">
                      {editingQuestionId && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => resetQuestionForm()}
                        >
                          Cancel Edit
                        </Button>
                      )}
                      <Button type="submit" disabled={savingQuestion}>
                        {savingQuestion
                          ? "Saving..."
                          : editingQuestionId
                            ? "Update Question"
                            : "Add Question"}
                      </Button>
                    </div>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {tab === "import" && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Validated CSV / JSON Question Import</CardTitle>
                <CardDescription>
                  Download a template, validate every row before commit, and transactionally import into this draft.
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void handleDownloadFile(
                      "/teacher/exams/templates/csv",
                      "questions-template.csv",
                    )
                  }
                >
                  <Download className="h-4 w-4" />
                  CSV Template
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void handleDownloadFile(
                      "/teacher/exams/templates/json",
                      "questions-template.json",
                    )
                  }
                >
                  <Download className="h-4 w-4" />
                  JSON Template
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2 text-sm">
                <Label htmlFor="import-format">Format:</Label>
                <select
                  id="import-format"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={importFormat}
                  onChange={(e) => {
                    setImportFormat(e.target.value as "csv" | "json");
                    setImportPreview(null);
                  }}
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                </select>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                <Upload className="h-4 w-4" />
                Load File
                <input
                  type="file"
                  className="hidden"
                  accept=".csv,.json,text/csv,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.name.toLowerCase().endsWith(".json")) {
                      setImportFormat("json");
                    } else if (file.name.toLowerCase().endsWith(".csv")) {
                      setImportFormat("csv");
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      setImportContent(String(reader.result ?? ""));
                      setImportPreview(null);
                    };
                    reader.readAsText(file);
                  }}
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="import-textarea">CSV / JSON Content</Label>
              <textarea
                id="import-textarea"
                rows={8}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                value={importContent}
                onChange={(e) => {
                  setImportContent(e.target.value);
                  setImportPreview(null);
                }}
                placeholder="Paste CSV or JSON question rows here..."
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={importing || !importContent.trim()}
                onClick={() => void handleImportPreviewOrCommit("preview")}
              >
                <Eye className="h-4 w-4" />
                Preview &amp; Validate
              </Button>
              <Button
                type="button"
                disabled={
                  !isEditable ||
                  importing ||
                  !importPreview ||
                  importPreview.validCount === 0 ||
                  importPreview.invalidCount > 0
                }
                onClick={() => void handleImportPreviewOrCommit("import")}
              >
                <FileUp className="h-4 w-4" />
                Commit Import ({importPreview?.validCount ?? 0} questions)
              </Button>
            </div>

            {importPreview && (
              <div className="space-y-3 pt-2">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">Rows: {importPreview.totalRows}</Badge>
                  <Badge variant="success">Valid: {importPreview.validCount}</Badge>
                  <Badge variant={importPreview.invalidCount > 0 ? "destructive" : "outline"}>
                    Invalid: {importPreview.invalidCount}
                  </Badge>
                </div>

                <div className="max-h-72 overflow-y-auto rounded-md border">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b bg-muted/40">
                      <tr>
                        <th className="p-2">Row</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Type</th>
                        <th className="p-2">Prompt / Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row) => (
                        <tr key={row.row} className="border-b last:border-0">
                          <td className="p-2 font-mono">#{row.row}</td>
                          <td className="p-2">
                            <Badge variant={row.valid ? "success" : "destructive"}>
                              {row.valid ? "Valid" : "Error"}
                            </Badge>
                          </td>
                          <td className="p-2">{row.question?.type ?? "—"}</td>
                          <td className="p-2">
                            {row.valid ? (
                              <span className="line-clamp-2">{row.question?.prompt}</span>
                            ) : (
                              <span className="text-destructive">{row.error}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "preview" && (
        <Card>
          <CardHeader>
            <CardTitle>Teacher Examination Preview</CardTitle>
            <CardDescription>
              Student-facing layout preview ({exam.durationMinutes} min · {exam.totalMarks} marks · Pass {exam.passingMarks})
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {exam.instructions && (
              <div className="rounded-md border bg-muted/40 p-4 text-sm">
                <p className="font-semibold">Instructions</p>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{exam.instructions}</p>
              </div>
            )}

            {exam.questions.map((q) => (
              <div key={q.id} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    Question {q.orderIndex} {q.isRequired ? "*" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatQuestionTypeLabel(q.type)} · {q.marks} marks
                    {q.negativeMarks > 0 ? ` (-${q.negativeMarks} penalty)` : ""}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{q.prompt}</p>
                {q.options.length > 0 ? (
                  <div className="space-y-1.5">
                    {q.options.map((opt) => (
                      <div key={opt.id} className="rounded border px-3 py-2 text-sm">
                        <span className="mr-2 font-medium">{opt.label}.</span>
                        {opt.text}
                      </div>
                    ))}
                  </div>
                ) : (
                  <textarea
                    disabled
                    rows={q.type === QuestionType.SUBJECTIVE_LONG ? 5 : 2}
                    className="w-full rounded-md border bg-muted/30 p-2 text-xs"
                    placeholder="Candidate response box (read-only preview)"
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {tab === "attempts" && (
        <Card>
          <CardHeader>
            <CardTitle>Student Attempts &amp; Submission History</CardTitle>
            <CardDescription>
              Read-only view of authorized attempts and immutable receipts for this examination.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {attempts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No student attempts recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Student</th>
                      <th className="py-2 pr-3">Attempt</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Progress</th>
                      <th className="py-2 pr-3">Started / Submitted</th>
                      <th className="py-2">Receipt</th>
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
                          {a.answeredCount} / {a.questionCount} answered
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          <div>Start: {formatDateTimeShort(a.startedAt)}</div>
                          <div>End: {formatDateTimeShort(a.submittedAt ?? a.expiresAt)}</div>
                        </td>
                        <td className="py-2.5 font-mono text-xs">{a.receiptCode ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "integrity" && (
        <Card>
          <CardHeader>
            <CardTitle>Course Examination Integrity Events (Read-Only)</CardTitle>
            <CardDescription>
              Course instructors can review integrity telemetry and strike outcomes for their assigned courses; institutional proctoring policy changes remain restricted to administrators.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {integrityEvents.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No proctoring or integrity events recorded for this examination yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Occurred</th>
                      <th className="py-2 pr-3">Candidate</th>
                      <th className="py-2 pr-3">Event Type</th>
                      <th className="py-2 pr-3">Confidence</th>
                      <th className="py-2 pr-3">Strike Impact</th>
                      <th className="py-2">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {integrityEvents.map((ev) => (
                      <tr key={ev.id} className="border-b last:border-0">
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          {formatDateTimeShort(ev.occurredAt)}
                        </td>
                        <td className="py-2.5 pr-3 font-medium">
                          {ev.studentName ?? "Candidate"}
                        </td>
                        <td className="py-2.5 pr-3">
                          <Badge variant={ev.severity === "CRITICAL" ? "destructive" : "outline"}>
                            {ev.eventType}
                          </Badge>
                        </td>
                        <td className="py-2.5 pr-3 text-xs">{ev.confidence}</td>
                        <td className="py-2.5 pr-3 font-mono text-xs">
                          {ev.countedAsStrike ? (
                            <span className="text-destructive font-semibold">
                              Strike #{ev.violationNumberAfter}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Non-strike</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground">{ev.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
