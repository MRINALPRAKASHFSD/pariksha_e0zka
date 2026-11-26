import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import type { AssignmentSummaryDto, PaginatedResult } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export function StudentAssignmentsPage() {
  const [data, setData] = useState<PaginatedResult<AssignmentSummaryDto> | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "upcoming" | "completed">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "25", filter });
      if (search.trim()) params.set("search", search.trim());
      const res = await apiRequest<PaginatedResult<AssignmentSummaryDto>>(
        `/student/assignments?${params.toString()}`,
      );
      setData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load assignments.");
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Assignments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View published coursework, download attachments, submit solutions, and check released
          grades.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filter Coursework</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search assignments"
              placeholder="Search title..."
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label="Filter assignment status"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as "all" | "pending" | "upcoming" | "completed")
            }
          >
            <option value="all">All Published Assignments</option>
            <option value="pending">Pending Submission</option>
            <option value="upcoming">Upcoming Deadlines</option>
            <option value="completed">Submitted / Completed</option>
          </select>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Assignment</th>
                  <th className="px-4 py-3 font-medium">Deadline</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Marks</th>
                  <th className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <tr key={idx}>
                      <td className="px-4 py-3" colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))
                ) : data && data.items.length > 0 ? (
                  data.items.map((a) => {
                    const sub = a.mySubmission;
                    return (
                      <tr key={a.id} className="hover:bg-muted/30">
                        <td className="px-4 py-3">
                          <Link
                            to={`/student/assignments/${a.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {a.title}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {a.courseCode} — {a.courseTitle}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {new Date(a.dueAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          {sub ? (
                            <Badge variant={sub.isGradePublished ? "success" : "default"}>
                              {sub.isGradePublished ? "GRADED" : sub.status}
                            </Badge>
                          ) : (
                            <Badge variant="warning">PENDING</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {sub?.isGradePublished && sub.score !== null
                            ? `${sub.score} / ${a.maxMarks}`
                            : `— / ${a.maxMarks}`}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/student/assignments/${a.id}`}>
                              {sub ? "View Submission" : "Submit Work"}
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No published assignments match your filter.
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
