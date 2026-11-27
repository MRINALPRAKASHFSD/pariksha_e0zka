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

export function StudentCoursesPage() {
  const [data, setData] = useState<PaginatedResult<CourseSummaryDto> | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "20" });
      if (search.trim()) params.set("search", search.trim());
      const res = await apiRequest<PaginatedResult<CourseSummaryDto>>(
        `/student/courses?${params.toString()}`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load enrolled courses.");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Enrolled Courses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Courses in which you currently hold an active enrollment.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search enrolled courses"
            placeholder="Search code or title..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
                  Instructor: {course.teacher.fullName}
                  {course.semester ? ` · ${course.semester}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{course.assignmentCount} published assignment(s)</span>
                  <span>{course.examCount} exam(s)</span>
                </div>
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link to={`/student/courses/${course.id}`}>
                    View Course
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
            You are not actively enrolled in any courses yet.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
