import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  FileText,
  KeyRound,
  Users,
} from "lucide-react";
import type { TeacherDashboardStatsDto } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function TeacherDashboardPage() {
  const [data, setData] = useState<TeacherDashboardStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await apiRequest<TeacherDashboardStatsDto>("/teacher/dashboard");
        if (active) setData(res);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load teacher portal.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Teacher Workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? `${data.profile.fullName} (${data.profile.email}) · Assigned courses, assignments & grading.`
              : "Manage your assigned courses, assignments, and submissions."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/teacher/assignments">
              Manage Assignments
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/teacher/courses">My Courses</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/security">
              <KeyRound className="h-4 w-4" />
              Security
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Assigned Courses</CardTitle>
            <BookOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.assignedCourses ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Active assigned terms</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Enrolled Students</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.totalEnrolledStudents ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Across active courses</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Published Assignments</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.publishedAssignments ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Visible to students</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Submissions</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.pendingSubmissions ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Not yet submitted</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Awaiting Grading</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.awaitingGrading ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Submitted / late work</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming Assignment Deadlines</CardTitle>
            <CardDescription>Published assignments with active due dates.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : data && data.upcomingDeadlines.length > 0 ? (
              <ul className="divide-y text-sm">
                {data.upcomingDeadlines.map((item) => (
                  <li key={item.id} className="flex items-center justify-between py-2.5 gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/teacher/assignments/${item.id}`}
                        className="font-medium text-primary hover:underline truncate block"
                      >
                        {item.courseCode} · {item.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        Due {new Date(item.dueAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant="outline">{item.submissionCount} submitted</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No upcoming assignment deadlines.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Student Submissions</CardTitle>
            <CardDescription>Latest files submitted across your courses.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : data && data.recentSubmissions.length > 0 ? (
              <ul className="divide-y text-sm">
                {data.recentSubmissions.map((sub) => (
                  <li key={sub.id} className="flex items-center justify-between py-2.5 gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/teacher/assignments/${sub.assignmentId}`}
                        className="font-medium text-primary hover:underline truncate block"
                      >
                        {sub.studentName} — {sub.assignmentTitle}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {sub.courseCode} · {new Date(sub.submittedAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant={sub.status === "GRADED" ? "success" : "default"}>
                      {sub.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No student submissions received yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
