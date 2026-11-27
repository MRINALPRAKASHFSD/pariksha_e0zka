import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Search } from "lucide-react";
import type { CourseSummaryDto, PaginatedResult } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function TeacherCoursesPage() {
  const [data, setData] = useState<PaginatedResult<CourseSummaryDto> | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "12" });
      if (search.trim()) params.set("search", search.trim());
      const res = await apiRequest<PaginatedResult<CourseSummaryDto>>(
        `/teacher/courses?${params.toString()}`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load assigned courses.");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Assigned Courses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Courses assigned to you by the institutional administrator.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search my courses"
            placeholder="Search code or title..."
            className="pl-8"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, idx) => (
            <Skeleton key={idx} className="h-44 w-full" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.items.map((course) => (
            <Card key={course.id} className="flex flex-col justify-between">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="default">{course.code}</Badge>
                  <Badge variant={course.isActive ? "success" : "warning"}>
                    {course.isActive ? "ACTIVE" : "ARCHIVED"}
                  </Badge>
                </div>
                <CardTitle className="pt-1 text-lg">{course.title}</CardTitle>
                <CardDescription>
                  {course.semester ?? "—"}
                  {course.department ? ` · ${course.department}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded border p-2">
                    <p className="font-semibold text-sm">{course.activeEnrollmentCount}</p>
                    <p className="text-muted-foreground">Students</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="font-semibold text-sm">{course.assignmentCount}</p>
                    <p className="text-muted-foreground">Assignments</p>
                  </div>
                  <div className="rounded border p-2">
                    <p className="font-semibold text-sm">{course.examCount}</p>
                    <p className="text-muted-foreground">Exams</p>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link to={`/teacher/courses/${course.id}`}>
                    Open Course Workspace
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No courses are currently assigned to your account.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
