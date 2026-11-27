import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Search } from "lucide-react";
import type { CourseDetailDto, EnrollmentItemDto, PaginatedResult } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function TeacherCourseDetailPage() {
  const { id: courseId } = useParams<{ id: string }>();
  const [course, setCourse] = useState<CourseDetailDto | null>(null);
  const [studentsPage, setStudentsPage] = useState<PaginatedResult<EnrollmentItemDto> | null>(null);
  const [studentSearch, setStudentSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "ACTIVE" | "DROPPED">("ACTIVE");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setError(null);
    try {
      const detail = await apiRequest<CourseDetailDto>(`/teacher/courses/${courseId}`);
      setCourse(detail);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load course details.");
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  const loadStudents = useCallback(async () => {
    if (!courseId) return;
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "50" });
      if (studentSearch.trim()) params.set("search", studentSearch.trim());
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      const res = await apiRequest<PaginatedResult<EnrollmentItemDto>>(
        `/teacher/courses/${courseId}/students?${params.toString()}`,
      );
      setStudentsPage(res);
    } catch {
      // Errors surfaced from detail fetch
    }
  }, [courseId, studentSearch, statusFilter]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    void loadStudents();
  }, [loadStudents]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (error || !course) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/teacher/courses">
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
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/teacher/courses">
              <ArrowLeft className="h-4 w-4" />
              My Courses
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
          {course.description && (
            <p className="mt-1 text-sm text-muted-foreground">{course.description}</p>
          )}
        </div>
        <Button asChild size="sm">
          <Link to={`/teacher/assignments?courseId=${course.id}`}>Manage Assignments</Link>
        </Button>
      </div>

      {/* Assignments in Course */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Course Assignments</CardTitle>
          <CardDescription>Click an assignment to upload attachments or grade work.</CardDescription>
        </CardHeader>
        <CardContent>
          {course.assignments.length > 0 ? (
            <ul className="divide-y text-sm">
              {course.assignments.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <Link
                      to={`/teacher/assignments/${a.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {a.title}
                    </Link>
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
            <p className="text-sm text-muted-foreground">No assignments in this course yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Enrolled Students List */}
      <Card>
        <CardHeader className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle className="text-base">Enrolled Students</CardTitle>
            <CardDescription>Search and filter students in {course.code}.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Filter enrolled students"
                placeholder="Search student..."
                className="pl-8 w-52"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
              />
            </div>
            <select
              aria-label="Enrollment status filter"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "ALL" | "ACTIVE" | "DROPPED")}
            >
              <option value="ACTIVE">Active</option>
              <option value="DROPPED">Dropped</option>
              <option value="ALL">All</option>
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Student</th>
                  <th className="px-4 py-3 font-medium">Enrollment Status</th>
                  <th className="px-4 py-3 font-medium">Enrolled On</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {studentsPage && studentsPage.items.length > 0 ? (
                  studentsPage.items.map((enr) => (
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
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(enr.enrolledAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-6 text-center text-muted-foreground" colSpan={3}>
                      No students match the selected filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
