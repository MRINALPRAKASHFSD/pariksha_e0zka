import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Upload, UserPlus, UserX } from "lucide-react";
import type {
  AdminUserListItemDto,
  AdminUsersListResponse,
  BulkEnrollmentImportResultDto,
  CourseDetailDto,
  EnrollmentItemDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminCourseDetailPage() {
  const { id: courseId } = useParams<{ id: string }>();
  const { pushToast } = useToast();

  const [course, setCourse] = useState<CourseDetailDto | null>(null);
  const [students, setStudents] = useState<AdminUserListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const [csvOpen, setCsvOpen] = useState(false);
  const [csvContent, setCsvContent] = useState("email\n");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<BulkEnrollmentImportResultDto | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setError(null);
    try {
      const [detail, studentList] = await Promise.all([
        apiRequest<CourseDetailDto>(`/admin/courses/${courseId}`),
        apiRequest<AdminUsersListResponse>(
          "/admin/users?role=STUDENT&status=ACTIVE&page=1&pageSize=100",
        ),
      ]);
      setCourse(detail);
      setStudents(studentList.items);
      if (studentList.items[0] && !selectedStudentId) {
        setSelectedStudentId(studentList.items[0].id);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load course details.");
    } finally {
      setLoading(false);
    }
  }, [courseId, selectedStudentId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  const handleEnrollStudent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!courseId) return;
    setEnrollError(null);
    setEnrolling(true);
    try {
      await apiRequest<EnrollmentItemDto>(`/admin/courses/${courseId}/enrollments`, {
        method: "POST",
        body: JSON.stringify({ studentId: selectedStudentId }),
      });
      pushToast({ title: "Student enrolled", description: "Enrollment is now active." });
      setEnrollOpen(false);
      await fetchDetail();
    } catch (err) {
      setEnrollError(err instanceof ApiClientError ? err.message : "Enrollment failed.");
    } finally {
      setEnrolling(false);
    }
  };

  const handleUpdateEnrollmentStatus = async (
    enrollment: EnrollmentItemDto,
    status: "ACTIVE" | "DROPPED",
  ) => {
    try {
      await apiRequest<EnrollmentItemDto>(`/admin/enrollments/${enrollment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      pushToast({
        title: status === "DROPPED" ? "Enrollment deactivated" : "Enrollment reactivated",
        description: `${enrollment.student.email} (${status})`,
      });
      await fetchDetail();
    } catch (err) {
      pushToast({
        title: "Enrollment update failed",
        description: err instanceof ApiClientError ? err.message : "Request failed.",
      });
    }
  };

  const handleBulkImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!courseId) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await apiRequest<BulkEnrollmentImportResultDto>(
        `/admin/courses/${courseId}/enrollments/import`,
        {
          method: "POST",
          body: JSON.stringify({ csvContent }),
        },
      );
      setImportResult(res);
      pushToast({
        title: "CSV import complete",
        description: `Enrolled ${res.enrolledCount}, reactivated ${res.reactivatedCount}, skipped ${res.skippedCount}.`,
      });
      await fetchDetail();
    } catch (err) {
      pushToast({
        title: "CSV import failed",
        description: err instanceof ApiClientError ? err.message : "Invalid CSV payload.",
      });
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !course) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/courses">
            <ArrowLeft className="h-4 w-4" />
            Back to Courses
          </Link>
        </Button>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Course not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/admin/courses">
              <ArrowLeft className="h-4 w-4" />
              All Courses
            </Link>
          </Button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {course.code} — {course.title}
            </h1>
            <Badge variant={course.isActive ? "success" : "warning"}>
              {course.isActive ? "ACTIVE" : "ARCHIVED"}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Instructor: {course.teacher.fullName} ({course.teacher.email}) · Term:{" "}
            {course.semester ?? "—"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!course.isActive}
            onClick={() => {
              setImportResult(null);
              setCsvOpen(true);
            }}
          >
            <Upload className="h-4 w-4" />
            Bulk CSV Enroll
          </Button>
          <Button
            size="sm"
            disabled={!course.isActive}
            onClick={() => {
              setEnrollError(null);
              setEnrollOpen(true);
            }}
          >
            <UserPlus className="h-4 w-4" />
            Enroll Student
          </Button>
        </div>
      </div>

      {/* Course Overview Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Active Enrollments</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">
              {course.activeEnrollmentCount}
              {course.capacity !== null ? ` / ${course.capacity}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              Historical submissions preserved if dropped
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Course Assignments</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{course.assignments.length}</p>
            <p className="text-xs text-muted-foreground">Published &amp; draft coursework</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Examinations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{course.exams.length}</p>
            <p className="text-xs text-muted-foreground">Scheduled examinations (Phase 4)</p>
          </CardContent>
        </Card>
      </div>

      {/* Enrolled Students Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enrollment Roster</CardTitle>
          <CardDescription>
            Deactivating an enrollment revokes course access while preserving historical submissions.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Student</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Submissions</th>
                  <th className="px-4 py-3 font-medium">Enrolled</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {course.enrollments.length > 0 ? (
                  course.enrollments.map((enr) => (
                    <tr key={enr.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{enr.student.fullName}</p>
                        <p className="text-xs text-muted-foreground">{enr.student.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={enr.status === "ACTIVE" ? "success" : "warning"}>
                          {enr.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{enr.submissionCount ?? 0}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(enr.enrolledAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {enr.status === "ACTIVE" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleUpdateEnrollmentStatus(enr, "DROPPED")}
                          >
                            <UserX className="h-3.5 w-3.5" />
                            Drop
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleUpdateEnrollmentStatus(enr, "ACTIVE")}
                          >
                            Reactivate
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No students enrolled in this course yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Assignments Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Course Assignments</CardTitle>
        </CardHeader>
        <CardContent>
          {course.assignments.length > 0 ? (
            <ul className="divide-y text-sm">
              {course.assignments.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-xs text-muted-foreground">
                      Due {new Date(a.dueAt).toLocaleString()} · Max {a.maxMarks} marks
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={a.status === "PUBLISHED" ? "success" : "outline"}>
                      {a.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {a.submissionStats?.totalSubmissions ?? 0} submission(s)
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No assignments created for this course.</p>
          )}
        </CardContent>
      </Card>

      {/* Enroll Single Student Dialog */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll Student in {course.code}</DialogTitle>
            <DialogDescription>Select an active student account to enroll.</DialogDescription>
          </DialogHeader>
          {enrollError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {enrollError}
            </div>
          )}
          <form onSubmit={(e) => void handleEnrollStudent(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="enroll-student-select">Student</Label>
              <select
                id="enroll-student-select"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={selectedStudentId}
                onChange={(e) => setSelectedStudentId(e.target.value)}
                required
              >
                <option value="">Select student...</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setEnrollOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={enrolling || !selectedStudentId}>
                {enrolling && <Loader2 className="h-4 w-4 animate-spin" />}
                Enroll Student
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Bulk CSV Import Dialog */}
      <Dialog open={csvOpen} onOpenChange={setCsvOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk CSV Enrollment</DialogTitle>
            <DialogDescription>
              Paste CSV containing an <code>email</code> header column (one student email per row).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleBulkImport(e)} className="space-y-3">
            <textarea
              aria-label="CSV enrollment input"
              rows={6}
              className="w-full rounded-md border border-input bg-background p-2.5 font-mono text-xs"
              value={csvContent}
              onChange={(e) => setCsvContent(e.target.value)}
              required
            />
            {importResult && (
              <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
                <p className="font-medium">
                  Enrolled: {importResult.enrolledCount} · Reactivated:{" "}
                  {importResult.reactivatedCount} · Skipped: {importResult.skippedCount}
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="list-disc pl-4 text-destructive">
                    {importResult.errors.map((err, i) => (
                      <li key={i}>
                        Row {err.row} ({err.email || "empty"}): {err.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCsvOpen(false)}>
                Close
              </Button>
              <Button type="submit" disabled={importing}>
                {importing && <Loader2 className="h-4 w-4 animate-spin" />}
                Import CSV
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
