import React, { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Archive, CheckCircle, Loader2, Plus, Search } from "lucide-react";
import {
  type AssignmentStatus,
  type AssignmentSummaryDto,
  type CourseSummaryDto,
  type PaginatedResult,
} from "@pariksha/shared";
import { ApiClientError, apiRequest, apiUploadWithProgress } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { FileDropzone } from "@/components/FileDropzone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

function defaultDueInputValue(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function TeacherAssignmentsPage() {
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();

  const [courses, setCourses] = useState<CourseSummaryDto[]>([]);
  const [assignments, setAssignments] = useState<PaginatedResult<AssignmentSummaryDto> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState(searchParams.get("courseId") ?? "ALL");
  const [statusFilter, setStatusFilter] = useState<AssignmentStatus | "ALL">("ALL");

  // Create Dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [courseId, setCourseId] = useState(searchParams.get("courseId") ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [maxMarks, setMaxMarks] = useState("100");
  const [dueAtLocal, setDueAtLocal] = useState(defaultDueInputValue);
  const [allowLate, setAllowLate] = useState(false);
  const [allowResubmission, setAllowResubmission] = useState(false);
  const [publishNow, setPublishNow] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "25" });
      if (search.trim()) params.set("search", search.trim());
      if (courseFilter !== "ALL") params.set("courseId", courseFilter);
      if (statusFilter !== "ALL") params.set("status", statusFilter);

      const [courseRes, assignRes] = await Promise.all([
        apiRequest<PaginatedResult<CourseSummaryDto>>("/teacher/courses?page=1&pageSize=100"),
        apiRequest<PaginatedResult<AssignmentSummaryDto>>(
          `/teacher/assignments?${params.toString()}`,
        ),
      ]);
      setCourses(courseRes.items.filter((c) => c.isActive));
      if (courseRes.items[0] && !courseId) {
        setCourseId(courseRes.items[0].id);
      }
      setAssignments(assignRes);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load assignments.");
    } finally {
      setLoading(false);
    }
  }, [search, courseFilter, statusFilter, courseId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    if (!courseId) {
      setCreateError("Select an active course.");
      return;
    }

    const formData = new FormData();
    formData.append("courseId", courseId);
    formData.append("title", title);
    if (description.trim()) formData.append("description", description.trim());
    if (instructions.trim()) formData.append("instructions", instructions.trim());
    formData.append("maxMarks", maxMarks);
    formData.append("dueAt", new Date(dueAtLocal).toISOString());
    formData.append("allowLateSubmissions", String(allowLate));
    formData.append("allowResubmission", String(allowResubmission));
    formData.append("publishImmediately", String(publishNow));
    for (const file of files) {
      formData.append("attachments", file);
    }

    setCreating(true);
    setUploadProgress(files.length > 0 ? 0 : null);
    try {
      const created = await apiUploadWithProgress<AssignmentSummaryDto>(
        "/teacher/assignments",
        formData,
        (pct) => setUploadProgress(pct),
      );
      pushToast({
        title: created.isPublished ? "Assignment created & published" : "Draft assignment created",
        description: created.title,
      });
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setInstructions("");
      setFiles([]);
      setUploadProgress(null);
      await loadData();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create assignment.");
      setUploadProgress(null);
    } finally {
      setCreating(false);
    }
  };

  const handlePublish = async (assignment: AssignmentSummaryDto) => {
    try {
      await apiRequest<AssignmentSummaryDto>(`/teacher/assignments/${assignment.id}/publish`, {
        method: "POST",
      });
      pushToast({ title: "Assignment published", description: assignment.title });
      await loadData();
    } catch (err) {
      pushToast({
        title: "Publish failed",
        description: err instanceof ApiClientError ? err.message : "Unable to publish.",
      });
    }
  };

  const handleArchive = async (assignment: AssignmentSummaryDto) => {
    try {
      await apiRequest<AssignmentSummaryDto>(`/teacher/assignments/${assignment.id}/archive`, {
        method: "POST",
      });
      pushToast({ title: "Assignment archived", description: assignment.title });
      await loadData();
    } catch (err) {
      pushToast({
        title: "Archive failed",
        description: err instanceof ApiClientError ? err.message : "Unable to archive.",
      });
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Assignments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create draft coursework, upload reference files, publish deadlines, and grade work.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={courses.length === 0}>
          <Plus className="h-4 w-4" />
          Create Assignment
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
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
            aria-label="Filter by course"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
          >
            <option value="ALL">All Assigned Courses</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.title}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by assignment status"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AssignmentStatus | "ALL")}
          >
            <option value="ALL">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
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
                  <th className="px-4 py-3 font-medium">Submissions</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
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
                ) : assignments && assignments.items.length > 0 ? (
                  assignments.items.map((item) => (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          to={`/teacher/assignments/${item.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {item.title}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {item.courseCode} · Max {item.maxMarks} marks · {item.attachments.length}{" "}
                          file(s)
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {new Date(item.dueAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            item.status === "PUBLISHED"
                              ? "success"
                              : item.status === "DRAFT"
                                ? "outline"
                                : "warning"
                          }
                        >
                          {item.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {item.submissionStats?.totalSubmissions ?? 0} total ·{" "}
                        {item.submissionStats?.pendingGrading ?? 0} ungraded
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/teacher/assignments/${item.id}`}>Open</Link>
                          </Button>
                          {item.status === "DRAFT" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handlePublish(item)}
                            >
                              <CheckCircle className="h-3.5 w-3.5" />
                              Publish
                            </Button>
                          )}
                          {item.status !== "ARCHIVED" && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void handleArchive(item)}
                            >
                              <Archive className="h-3.5 w-3.5" />
                              Archive
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No assignments found. Create a draft assignment to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Create Assignment Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Assignment</DialogTitle>
            <DialogDescription>
              Draft assignments remain hidden from students until published.
            </DialogDescription>
          </DialogHeader>

          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {createError}
            </div>
          )}

          <form onSubmit={(e) => void handleCreate(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="assign-course">Course</Label>
              <select
                id="assign-course"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                required
              >
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="assign-title">Title</Label>
              <Input
                id="assign-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="assign-marks">Maximum Marks</Label>
                <Input
                  id="assign-marks"
                  type="number"
                  min={1}
                  step="0.5"
                  value={maxMarks}
                  onChange={(e) => setMaxMarks(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="assign-due">Due Date &amp; Time</Label>
                <Input
                  id="assign-due"
                  type="datetime-local"
                  value={dueAtLocal}
                  onChange={(e) => setDueAtLocal(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="assign-desc">Summary Description</Label>
              <textarea
                id="assign-desc"
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="assign-instructions">Instructions</Label>
              <textarea
                id="assign-instructions"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowLate}
                  onChange={(e) => setAllowLate(e.target.checked)}
                />
                Allow late submissions
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allowResubmission}
                  onChange={(e) => setAllowResubmission(e.target.checked)}
                />
                Allow resubmission before grading
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={publishNow}
                  onChange={(e) => setPublishNow(e.target.checked)}
                />
                Publish immediately
              </label>
            </div>

            <FileDropzone
              files={files}
              onFilesChange={setFiles}
              uploadProgress={uploadProgress}
              disabled={creating}
              inputId="teacher-assignment-files"
              label="Assignment Handouts / Attachments"
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                {publishNow ? "Create & Publish" : "Save Draft"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
