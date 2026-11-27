import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Lock,
  Play,
  Receipt,
  Search,
  ShieldAlert,
} from "lucide-react";
import type {
  PaginatedResult,
  StudentExamAttemptDto,
  StudentExamListItemDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { formatDateTimeShort } from "@/lib/examUi";
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
import { Skeleton } from "@/components/ui/skeleton";

type ExamFilter = "all" | "available" | "in_progress" | "upcoming" | "completed";

export function StudentExamsPage() {
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const [data, setData] = useState<PaginatedResult<StudentExamListItemDto> | null>(null);
  const [filter, setFilter] = useState<ExamFilter>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedStartExam, setSelectedStartExam] = useState<StudentExamListItemDto | null>(null);
  const [startingExamId, setStartingExamId] = useState<string | null>(null);

  const loadExams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: "1",
        pageSize: "50",
        filter,
      });
      if (search.trim()) params.set("search", search.trim());
      const res = await apiRequest<PaginatedResult<StudentExamListItemDto>>(
        `/student/exams?${params.toString()}`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load examinations.");
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    void loadExams();
  }, [loadExams]);

  const handleStartExam = async (exam: StudentExamListItemDto) => {
    setStartingExamId(exam.id);
    try {
      const attempt = await apiRequest<StudentExamAttemptDto>(`/student/exams/${exam.id}/start`, {
        method: "POST",
      });
      setSelectedStartExam(null);
      navigate(`/student/exams/${exam.id}/attempt/${attempt.id}`);
    } catch (err) {
      pushToast({
        title: "Unable to enter examination",
        description: err instanceof ApiClientError ? err.message : "Check exam availability.",
      });
      await loadExams();
    } finally {
      setStartingExamId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Examinations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View upcoming and active examinations for your enrolled courses, check delivery requirements, and resume attempts.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search student exams"
            placeholder="Search exam or course..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", "All"],
            ["available", "Available"],
            ["in_progress", "In Progress"],
            ["upcoming", "Upcoming"],
            ["completed", "Completed"],
          ] as Array<[ExamFilter, string]>
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={filter === key ? "default" : "outline"}
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, idx) => (
            <Skeleton key={idx} className="h-36 w-full" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {data.items.map((exam) => (
            <Card key={exam.id} className="flex flex-col justify-between">
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{exam.courseCode}</Badge>
                  <Badge
                    variant={
                      exam.eligibilityStatus === "AVAILABLE" ||
                      exam.eligibilityStatus === "IN_PROGRESS"
                        ? "success"
                        : exam.eligibilityStatus === "COMPLETED"
                          ? "default"
                          : exam.eligibilityStatus === "PROCTORING_UNAVAILABLE" ||
                              exam.eligibilityStatus === "PAUSED"
                            ? "warning"
                            : "outline"
                    }
                  >
                    {exam.eligibilityStatus.replace(/_/g, " ")}
                  </Badge>
                  <Badge variant="outline">v{exam.version}</Badge>
                  {exam.allowUnproctoredDev ? (
                    <Badge variant="warning">Dev Unproctored</Badge>
                  ) : (
                    <Badge variant="outline">Proctoring Required</Badge>
                  )}
                </div>

                <div>
                  <CardTitle className="text-lg">{exam.title}</CardTitle>
                  <CardDescription className="mt-1">
                    {exam.courseTitle} · {exam.questionCount} questions · {exam.totalMarks} marks
                    (Pass {exam.passingMarks})
                  </CardDescription>
                </div>
              </CardHeader>

              <CardContent className="space-y-4">
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Duration: {exam.durationMinutes} min · Attempts used: {exam.attemptsUsed} /{" "}
                    {exam.maxAttempts}
                  </div>
                  <div>
                    Window: {formatDateTimeShort(exam.windowStart)} →{" "}
                    {formatDateTimeShort(exam.windowEnd)}
                  </div>
                </div>

                {exam.eligibilityReason && (
                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {exam.eligibilityStatus === "PROCTORING_UNAVAILABLE" && (
                      <span className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{exam.eligibilityReason}</span>
                      </span>
                    )}
                    {exam.eligibilityStatus !== "PROCTORING_UNAVAILABLE" && exam.eligibilityReason}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  {exam.canResume && exam.activeAttemptId ? (
                    <Button
                      onClick={() =>
                        navigate(`/student/exams/${exam.id}/attempt/${exam.activeAttemptId}`)
                      }
                    >
                      <Play className="h-4 w-4" />
                      Resume Examination
                    </Button>
                  ) : exam.canStart && exam.eligibilityStatus === "PREFLIGHT_REQUIRED" ? (
                    <Button
                      onClick={() => navigate(`/student/exams/${exam.id}/preflight`)}
                    >
                      <Play className="h-4 w-4" />
                      Verify &amp; Start
                    </Button>
                  ) : exam.canStart ? (
                    <Button onClick={() => setSelectedStartExam(exam)}>
                      <Play className="h-4 w-4" />
                      Start Examination
                    </Button>
                  ) : exam.latestSubmission ? (
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigate(
                          `/student/exams/${exam.id}/attempt/${exam.latestSubmission!.attemptId}`,
                        )
                      }
                    >
                      <Receipt className="h-4 w-4" />
                      View Submission Receipt
                    </Button>
                  ) : (
                    <Button variant="outline" disabled>
                      <Lock className="h-4 w-4" />
                      Unavailable
                    </Button>
                  )}

                  {exam.latestSubmission && (
                    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      {exam.latestSubmission.receiptCode}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ClipboardCheck className="h-10 w-10 text-muted-foreground/60" />
            <p className="mt-3 text-base font-medium">No examinations found</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Examinations for your actively enrolled courses will appear here once scheduled by administration.
            </p>
          </CardContent>
        </Card>
      )}

      <Dialog open={selectedStartExam !== null} onOpenChange={(open) => !open && setSelectedStartExam(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedStartExam?.title}</DialogTitle>
            <DialogDescription>
              Review rules and server-timed policy before starting your examination attempt.
            </DialogDescription>
          </DialogHeader>

          {selectedStartExam && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <strong>Delivery Mode:</strong> {selectedStartExam.preflight.bannerLabel}
              </div>

              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Duration: {selectedStartExam.durationMinutes} minutes (capped at window close)</li>
                <li>• Questions: {selectedStartExam.questionCount} ({selectedStartExam.totalMarks} marks)</li>
                <li>• Attempts used: {selectedStartExam.attemptsUsed} of {selectedStartExam.maxAttempts}</li>
                <li>• Answers autosave directly to the server; no browser localStorage is used.</li>
              </ul>

              {selectedStartExam.instructions && (
                <div className="rounded-md border bg-muted/40 p-3 text-xs">
                  <p className="font-semibold">Instructor Instructions</p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {selectedStartExam.instructions}
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setSelectedStartExam(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={startingExamId === selectedStartExam.id}
                  onClick={() => void handleStartExam(selectedStartExam)}
                >
                  {startingExamId === selectedStartExam.id ? "Starting..." : "Begin Attempt Now"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
