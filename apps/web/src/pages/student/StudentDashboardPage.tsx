import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  FileText,
  GraduationCap,
  KeyRound,
} from "lucide-react";
import type { StudentDashboardStatsDto } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function StudentDashboardPage() {
  const [data, setData] = useState<StudentDashboardStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const res = await apiRequest<StudentDashboardStatsDto>("/student/dashboard");
        if (active) setData(res);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load student portal.");
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
          <h1 className="text-2xl font-semibold tracking-tight">Student Portal</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data
              ? `${data.profile.fullName} (${data.profile.email}) · Enrolled courses, assignments & grades.`
              : "Access your enrolled courses, assignments, and published results."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/student/assignments">
              View Assignments
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/student/courses">My Courses</Link>
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
            <CardTitle className="text-sm font-medium">Active Courses</CardTitle>
            <BookOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.activeEnrollments ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Enrolled terms</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Assignments</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.pendingAssignments ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Action required</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Submitted</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.submittedAssignments ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Assignment submissions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Published Grades</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.publishedGrades ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Released marks &amp; feedback</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Exam Results</CardTitle>
            <GraduationCap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p className="text-2xl font-semibold">{data?.counts.publishedExamResults ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Exams activate in Phase 4–6</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming Deadlines</CardTitle>
            <CardDescription>Published assignments across your active courses.</CardDescription>
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
                        to={`/student/assignments/${item.id}`}
                        className="font-medium text-primary hover:underline truncate block"
                      >
                        {item.courseCode} · {item.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        Due {new Date(item.dueAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant={item.submitted ? "success" : "warning"}>
                      {item.submitted ? "Submitted" : "Pending"}
                    </Badge>
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
            <CardTitle className="text-base">Recent Academic Activity</CardTitle>
            <CardDescription>Your latest submissions and published assignment grades.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : data && data.recentActivity.length > 0 ? (
              <ul className="divide-y text-sm">
                {data.recentActivity.map((act) => (
                  <li key={act.id} className="flex items-center justify-between py-2.5 gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/student/assignments/${act.assignmentId}`}
                        className="font-medium text-primary hover:underline truncate block"
                      >
                        {act.courseCode} · {act.assignmentTitle}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        Submitted {new Date(act.submittedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant={act.isGradePublished ? "success" : "default"}>
                        {act.isGradePublished && act.score !== null
                          ? `${act.score} / ${act.maxMarks}`
                          : act.status}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No submission activity recorded yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
