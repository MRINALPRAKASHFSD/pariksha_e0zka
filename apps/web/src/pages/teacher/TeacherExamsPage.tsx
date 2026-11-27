import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Copy,
  FilePlus2,
  FolderOpen,
  Plus,
  Search,
} from "lucide-react";
import {
  ExamStatus,
  type CourseSummaryDto,
  type ExamDetailDto,
  type ExamSummaryDto,
  type PaginatedResult,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import {
  formatDateTimeShort,
  fromDateTimeLocalValue,
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

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: ExamStatus.DRAFT, label: "Draft" },
  { value: ExamStatus.PENDING_APPROVAL, label: "Pending Approval" },
  { value: ExamStatus.APPROVED, label: "Approved" },
  { value: ExamStatus.REJECTED, label: "Rejected" },
  { value: ExamStatus.ACTIVE, label: "Active" },
  { value: ExamStatus.PAUSED, label: "Paused" },
  { value: ExamStatus.COMPLETED, label: "Completed" },
  { value: ExamStatus.CANCELLED, label: "Cancelled" },
];

export function TeacherExamsPage() {
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const [examsData, setExamsData] = useState<PaginatedResult<ExamSummaryDto> | null>(null);
  const [courses, setCourses] = useState<CourseSummaryDto[]>([]);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const now = new Date();
  const defaultStart = toDateTimeLocalValue(new Date(now.getTime() + 15 * 60_000).toISOString());
  const defaultEnd = toDateTimeLocalValue(new Date(now.getTime() + 24 * 60 * 60_000).toISOString());

  const [formCourseId, setFormCourseId] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formInstructions, setFormInstructions] = useState("");
  const [formDuration, setFormDuration] = useState("60");
  const [formPassingMarks, setFormPassingMarks] = useState("0");
  const [formMaxAttempts, setFormMaxAttempts] = useState("1");
  const [formWindowStart, setFormWindowStart] = useState(defaultStart);
  const [formWindowEnd, setFormWindowEnd] = useState(defaultEnd);
  const [formShuffleQuestions, setFormShuffleQuestions] = useState(false);
  const [formShuffleOptions, setFormShuffleOptions] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "10" });
      if (search.trim()) params.set("search", search.trim());
      if (courseFilter) params.set("courseId", courseFilter);
      if (statusFilter) params.set("status", statusFilter);

      const [examsRes, coursesRes] = await Promise.all([
        apiRequest<PaginatedResult<ExamSummaryDto>>(`/teacher/exams?${params.toString()}`),
        apiRequest<PaginatedResult<CourseSummaryDto>>("/teacher/courses?page=1&pageSize=100"),
      ]);
      setExamsData(examsRes);
      const activeCourses = coursesRes.items.filter((c) => c.isActive);
      setCourses(activeCourses);
      if (!formCourseId && activeCourses[0]) {
        setFormCourseId(activeCourses[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load examinations.");
    } finally {
      setLoading(false);
    }
  }, [page, search, courseFilter, statusFilter, formCourseId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreateExam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formCourseId) {
      pushToast({
        title: "Course required",
        description: "Select an active course assigned to you.",
      });
      return;
    }

    setCreating(true);
    try {
      const created = await apiRequest<ExamDetailDto>("/teacher/exams", {
        method: "POST",
        body: JSON.stringify({
          courseId: formCourseId,
          title: formTitle.trim(),
          description: formDescription.trim() || null,
          instructions: formInstructions.trim() || null,
          durationMinutes: Number(formDuration),
          passingMarks: Number(formPassingMarks),
          maxAttempts: Number(formMaxAttempts),
          windowStart: fromDateTimeLocalValue(formWindowStart),
          windowEnd: fromDateTimeLocalValue(formWindowEnd),
          shuffleQuestions: formShuffleQuestions,
          shuffleOptions: formShuffleOptions,
        }),
      });
      pushToast({
        title: "Draft examination created",
        description: `${created.title} is ready for question authoring.`,
      });
      setCreateOpen(false);
      navigate(`/teacher/exams/${created.id}`);
    } catch (err) {
      pushToast({
        title: "Failed to create examination",
        description: err instanceof ApiClientError ? err.message : "Check form inputs.",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDuplicate = async (examId: string) => {
    setDuplicatingId(examId);
    try {
      const copy = await apiRequest<ExamDetailDto>(`/teacher/exams/${examId}/duplicate`, {
        method: "POST",
      });
      pushToast({
        title: "Draft duplicated",
        description: `Created "${copy.title}" as a fresh draft.`,
      });
      await loadData();
    } catch (err) {
      pushToast({
        title: "Duplicate failed",
        description: err instanceof ApiClientError ? err.message : "Could not duplicate exam.",
      });
    } finally {
      setDuplicatingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Examinations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Author draft exams, build multi-type question banks, import CSV/JSON questions, and submit for approval.
          </p>
        </div>
        <Button
          onClick={() => {
            const freshNow = new Date();
            setFormWindowStart(
              toDateTimeLocalValue(new Date(freshNow.getTime() + 5 * 60_000).toISOString()),
            );
            setFormWindowEnd(
              toDateTimeLocalValue(new Date(freshNow.getTime() + 24 * 60 * 60_000).toISOString()),
            );
            setCreateOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          New Exam Draft
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search examinations"
                placeholder="Search title or course..."
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <select
              aria-label="Filter by course"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={courseFilter}
              onChange={(e) => {
                setCourseFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All assigned courses</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.title}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by status"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : examsData && examsData.items.length > 0 ? (
        <div className="space-y-3">
          {examsData.items.map((exam) => (
            <Card key={exam.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{exam.courseCode}</Badge>
                      <Badge variant={getExamStatusBadgeVariant(exam.status)}>{exam.status}</Badge>
                      <Badge variant="outline">v{exam.version}</Badge>
                      {exam.allowUnproctoredDev && (
                        <Badge variant="warning">Dev Unproctored</Badge>
                      )}
                    </div>
                    <CardTitle className="text-lg">{exam.title}</CardTitle>
                    <CardDescription>
                      {exam.courseTitle} · {exam.questionCount} questions · {exam.totalMarks} marks
                      (Pass: {exam.passingMarks}) · {exam.durationMinutes} min · Max attempts:{" "}
                      {exam.maxAttempts}
                    </CardDescription>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={duplicatingId === exam.id}
                      onClick={() => void handleDuplicate(exam.id)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Duplicate
                    </Button>
                    <Button asChild size="sm">
                      <Link to={`/teacher/exams/${exam.id}`}>
                        <FolderOpen className="h-3.5 w-3.5" />
                        Manage &amp; Questions
                      </Link>
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 text-xs text-muted-foreground">
                <div className="flex flex-wrap gap-4">
                  <span>Window: {formatDateTimeShort(exam.windowStart)} → {formatDateTimeShort(exam.windowEnd)}</span>
                  <span>Attempts: {exam.attemptCount} (Active: {exam.activeAttemptCount}, Submissions: {exam.submissionCount})</span>
                </div>
                {exam.status === ExamStatus.REJECTED && exam.rejectionReason && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <strong>Rejection Feedback:</strong> {exam.rejectionReason}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {examsData.totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
              <span>
                Page {examsData.page} of {examsData.totalPages} ({examsData.total} exams)
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= examsData.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <FilePlus2 className="h-10 w-10 text-muted-foreground/60" />
            <p className="mt-3 text-base font-medium">No examinations yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first draft examination for one of your assigned courses.
            </p>
          </CardContent>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Examination Draft</DialogTitle>
            <DialogDescription>
              Configure exam window, duration, and instructions. Total marks are calculated automatically from questions.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => void handleCreateExam(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="exam-course">Assigned Course</Label>
              <select
                id="exam-course"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={formCourseId}
                onChange={(e) => setFormCourseId(e.target.value)}
                required
              >
                <option value="">Select course...</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="exam-title">Examination Title</Label>
              <Input
                id="exam-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g., Midterm Examination: Distributed Systems"
                required
                minLength={3}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="exam-duration">Duration (min)</Label>
                <Input
                  id="exam-duration"
                  type="number"
                  min={1}
                  max={600}
                  value={formDuration}
                  onChange={(e) => setFormDuration(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exam-passing">Passing Marks</Label>
                <Input
                  id="exam-passing"
                  type="number"
                  min={0}
                  step="0.5"
                  value={formPassingMarks}
                  onChange={(e) => setFormPassingMarks(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exam-attempts">Max Attempts</Label>
                <Input
                  id="exam-attempts"
                  type="number"
                  min={1}
                  max={10}
                  value={formMaxAttempts}
                  onChange={(e) => setFormMaxAttempts(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="exam-start">Availability Window Start</Label>
                <Input
                  id="exam-start"
                  type="datetime-local"
                  value={formWindowStart}
                  onChange={(e) => setFormWindowStart(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="exam-end">Availability Window End</Label>
                <Input
                  id="exam-end"
                  type="datetime-local"
                  value={formWindowEnd}
                  onChange={(e) => setFormWindowEnd(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="exam-description">Description</Label>
              <textarea
                id="exam-description"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Syllabus coverage and examination summary"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="exam-instructions">Candidate Instructions</Label>
              <textarea
                id="exam-instructions"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formInstructions}
                onChange={(e) => setFormInstructions(e.target.value)}
                placeholder="Rules, negative marking policy, and submission instructions"
              />
            </div>

            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formShuffleQuestions}
                  onChange={(e) => setFormShuffleQuestions(e.target.checked)}
                />
                Shuffle question order per attempt
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formShuffleOptions}
                  onChange={(e) => setFormShuffleOptions(e.target.checked)}
                />
                Shuffle option order per attempt
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create Draft"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
