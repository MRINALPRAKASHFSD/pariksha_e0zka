import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import type { CourseDetailDto } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function StudentCourseDetailPage() {
  const { id: courseId } = useParams<{ id: string }>();
  const [course, setCourse] = useState<CourseDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!courseId) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest<CourseDetailDto>(`/student/courses/${courseId}`);
        if (active) setCourse(res);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load course details.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [courseId]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (error || !course) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/student/courses">
            <ArrowLeft className="h-4 w-4" />
            Back to My Courses
          </Link>
        </Button>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Course not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/student/courses">
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
        <p className="mt-1 text-sm text-muted-foreground">
          Instructor: {course.teacher.fullName} ({course.teacher.email}) · Term:{" "}
          {course.semester ?? "—"}
        </p>
        {course.description && (
          <p className="mt-2 text-sm text-foreground/90">{course.description}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Published Assignments</CardTitle>
          <CardDescription>Open an assignment to download files and submit work.</CardDescription>
        </CardHeader>
        <CardContent>
          {course.assignments.length > 0 ? (
            <ul className="divide-y text-sm">
              {course.assignments.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2.5 gap-3">
                  <div>
                    <Link
                      to={`/student/assignments/${a.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {a.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      Due {new Date(a.dueAt).toLocaleString()} · Max {a.maxMarks} marks
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.mySubmission ? (
                      <Badge variant={a.mySubmission.isGradePublished ? "success" : "default"}>
                        {a.mySubmission.isGradePublished && a.mySubmission.score !== null
                          ? `Graded: ${a.mySubmission.score} / ${a.maxMarks}`
                          : a.mySubmission.status}
                      </Badge>
                    ) : (
                      <Badge variant="warning">Pending</Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No published assignments in this course yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
