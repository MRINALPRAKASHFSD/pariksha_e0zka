import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ClipboardCheck, Eye, Search } from "lucide-react";
import { ExamStatus, type ExamSummaryDto, type PaginatedResult } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { formatDateTimeShort, getExamStatusBadgeVariant } from "@/lib/examUi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

interface AdminExamsListResponse extends PaginatedResult<ExamSummaryDto> {
  summary: {
    total: number;
    draft: number;
    pendingApproval: number;
    approved: number;
    rejected: number;
    active: number;
    paused: number;
    completed: number;
    cancelled: number;
  };
}

export function AdminExamsPage() {
  const [data, setData] = useState<AdminExamsListResponse | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [enabledFilter, setEnabledFilter] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadExams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "12" });
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter) params.set("status", statusFilter);
      if (enabledFilter) params.set("isEnabled", enabledFilter);

      const res = await apiRequest<AdminExamsListResponse>(`/admin/exams?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load institutional exams.");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, enabledFilter]);

  useEffect(() => {
    void loadExams();
  }, [loadExams]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Examination Control Center</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review teacher submissions, approve and schedule windows, pause/cancel live exams, and manage Phase 4 delivery policies.
        </p>
      </div>

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: "Total Exams", val: data.summary.total },
            { label: "Pending Approval", val: data.summary.pendingApproval },
            { label: "Active Now", val: data.summary.active },
            { label: "Approved / Scheduled", val: data.summary.approved },
            { label: "Paused / Cancelled", val: data.summary.paused + data.summary.cancelled },
          ].map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-2">
                <CardDescription>{stat.label}</CardDescription>
                <CardTitle className="text-2xl">{stat.val}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search institutional exams"
                placeholder="Search exam, course, or teacher..."
                className="pl-8"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <select
              aria-label="Filter by exam status"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {Object.values(ExamStatus).map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by enabled state"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={enabledFilter}
              onChange={(e) => {
                setEnabledFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Enabled &amp; disabled</option>
              <option value="true">Enabled only</option>
              <option value="false">Disabled only</option>
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
          {Array.from({ length: 3 }).map((_, idx) => (
            <Skeleton key={idx} className="h-28 w-full" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="space-y-3">
          {data.items.map((exam) => (
            <Card key={exam.id}>
              <CardHeader className="pb-3">
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{exam.courseCode}</Badge>
                      <Badge variant={getExamStatusBadgeVariant(exam.status)}>{exam.status}</Badge>
                      <Badge variant="outline">v{exam.version}</Badge>
                      {!exam.isEnabled && <Badge variant="destructive">Disabled</Badge>}
                      {exam.allowUnproctoredDev ? (
                        <Badge variant="warning">Dev Unproctored Enabled</Badge>
                      ) : (
                        <Badge variant="outline">Phase 5 Proctoring Required</Badge>
                      )}
                    </div>
                    <CardTitle className="text-lg">{exam.title}</CardTitle>
                    <CardDescription>
                      {exam.courseTitle} · Instructor: {exam.teacherName} · {exam.questionCount}{" "}
                      questions · {exam.totalMarks} marks · {exam.durationMinutes} min
                    </CardDescription>
                  </div>

                  <Button asChild size="sm">
                    <Link to={`/admin/exams/${exam.id}`}>
                      <Eye className="h-4 w-4" />
                      Inspect &amp; Control
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0 text-xs text-muted-foreground flex flex-wrap gap-4">
                <span>
                  Window: {formatDateTimeShort(exam.windowStart)} →{" "}
                  {formatDateTimeShort(exam.windowEnd)}
                </span>
                <span>
                  Attempts: {exam.attemptCount} (Active: {exam.activeAttemptCount} · Submissions:{" "}
                  {exam.submissionCount})
                </span>
              </CardContent>
            </Card>
          ))}

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
              <span>
                Page {data.page} of {data.totalPages} ({data.total} exams)
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
                  disabled={page >= data.totalPages}
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
            <ClipboardCheck className="h-10 w-10 text-muted-foreground/60" />
            <p className="mt-3 text-base font-medium">No matching examinations</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Teachers submit draft examinations here for administrative review and scheduling.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
