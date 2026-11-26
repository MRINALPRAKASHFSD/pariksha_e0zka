import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BookOpen, FileText, GraduationCap, ScrollText, Users } from "lucide-react";
import type { AdminDashboardStatsDto } from "@pariksha/shared";
import { useAuth } from "@/context/auth-context";
import { apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminDashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<AdminDashboardStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest<AdminDashboardStatsDto>("/admin/dashboard");
        if (active) setData(res);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load administrator overview");
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
          <h1 className="text-2xl font-semibold tracking-tight">Administrator Console</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as {user?.fullName} ({user?.email}). Live institutional academic &amp; user
            metrics.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to="/admin/courses">
              Courses &amp; Enrollments
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/users">Manage Users</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/audit-logs">Audit Logs</Link>
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Courses</CardTitle>
            <BookOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-semibold">{data?.courses.total ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "Loading..."
                : `${data?.courses.active ?? 0} Active · ${data?.courses.archived ?? 0} Archived`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-semibold">{data?.users.total ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "Loading..."
                : `${data?.users.byRole.TEACHER ?? 0} Teachers · ${data?.users.byRole.STUDENT ?? 0} Students`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Enrollments</CardTitle>
            <GraduationCap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-semibold">{data?.enrollments.active ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "Loading..."
                : `Active (${data?.enrollments.dropped ?? 0} dropped, ${data?.enrollments.completed ?? 0} completed)`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Assignments</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="text-2xl font-semibold">{data?.assignments.total ?? 0}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "Loading..."
                : `${data?.assignments.published ?? 0} Published · ${data?.assignments.submissions ?? 0} Submissions`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Academic & Security Activity */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent Institutional Activity</CardTitle>
            <CardDescription>Latest recorded academic and security audit events.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/audit-logs">
              <ScrollText className="h-4 w-4" />
              View All
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-28 w-full" />
          ) : data && data.recentActivity.length > 0 ? (
            <ul className="divide-y text-sm">
              {data.recentActivity.map((event) => (
                <li key={event.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{event.action}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.entityType}
                      {event.entityId ? ` · ${event.entityId.slice(0, 8)}...` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline">{event.actorRole ?? "SYSTEM"}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {new Date(event.createdAt).toLocaleString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No recent activity recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
