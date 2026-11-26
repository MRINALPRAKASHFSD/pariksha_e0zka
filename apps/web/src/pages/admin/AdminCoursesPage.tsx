import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, BookOpen, Loader2, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import {
  adminCreateCourseSchema,
  adminUpdateCourseSchema,
  type AdminUsersListResponse,
  type AdminUserListItemDto,
  type CourseSummaryDto,
  type PaginatedResult,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminCoursesPage() {
  const { pushToast } = useToast();

  const [coursesData, setCoursesData] = useState<PaginatedResult<CourseSummaryDto> | null>(null);
  const [teachers, setTeachers] = useState<AdminUserListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "true" | "false">("ALL");
  const [semesterFilter, setSemesterFilter] = useState("");
  const [page, setPage] = useState(1);

  // Create Dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [semester, setSemester] = useState("Fall 2026");
  const [capacity, setCapacity] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Edit Dialog
  const [editTarget, setEditTarget] = useState<CourseSummaryDto | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDepartment, setEditDepartment] = useState("");
  const [editSemester, setEditSemester] = useState("");
  const [editCapacity, setEditCapacity] = useState("");
  const [editTeacherId, setEditTeacherId] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadTeachers = useCallback(async () => {
    try {
      const res = await apiRequest<AdminUsersListResponse>(
        "/admin/users?role=TEACHER&status=ACTIVE&page=1&pageSize=100",
      );
      setTeachers(res.items);
      if (res.items[0] && !teacherId) {
        setTeacherId(res.items[0].id);
      }
    } catch {
      // Handled when creating/editing
    }
  }, [teacherId]);

  const fetchCourses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "10",
      });
      if (search.trim()) params.set("search", search.trim());
      if (statusFilter !== "ALL") params.set("isActive", statusFilter);
      if (semesterFilter.trim()) params.set("semester", semesterFilter.trim());

      const res = await apiRequest<PaginatedResult<CourseSummaryDto>>(
        `/admin/courses?${params.toString()}`,
      );
      setCoursesData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load courses.");
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, semesterFilter]);

  useEffect(() => {
    void loadTeachers();
  }, [loadTeachers]);

  useEffect(() => {
    void fetchCourses();
  }, [fetchCourses]);

  const handleCreateCourse = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError(null);

    const parsed = adminCreateCourseSchema.safeParse({
      code,
      title,
      description: description.trim() || undefined,
      department: department.trim() || undefined,
      semester,
      capacity: capacity.trim() ? Number(capacity) : null,
      teacherId,
    });
    if (!parsed.success) {
      setCreateError(parsed.error.issues[0]?.message ?? "Invalid course details.");
      return;
    }

    setCreating(true);
    try {
      const created = await apiRequest<CourseSummaryDto>("/admin/courses", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      pushToast({ title: "Course created", description: `${created.code} — ${created.title}` });
      setCreateOpen(false);
      setCode("");
      setTitle("");
      setDescription("");
      setDepartment("");
      setCapacity("");
      await fetchCourses();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create course.");
    } finally {
      setCreating(false);
    }
  };

  const openEditDialog = (course: CourseSummaryDto) => {
    setEditTarget(course);
    setEditTitle(course.title);
    setEditDescription(course.description ?? "");
    setEditDepartment(course.department ?? "");
    setEditSemester(course.semester ?? "");
    setEditCapacity(course.capacity !== null ? String(course.capacity) : "");
    setEditTeacherId(course.teacher.id);
    setEditError(null);
  };

  const handleSaveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editTarget) return;
    setEditError(null);

    const parsed = adminUpdateCourseSchema.safeParse({
      title: editTitle,
      description: editDescription.trim() || null,
      department: editDepartment.trim() || null,
      semester: editSemester,
      capacity: editCapacity.trim() ? Number(editCapacity) : null,
      teacherId: editTeacherId,
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Invalid course changes.");
      return;
    }

    setSavingEdit(true);
    try {
      await apiRequest<CourseSummaryDto>(`/admin/courses/${editTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      pushToast({ title: "Course updated", description: editTarget.code });
      setEditTarget(null);
      await fetchCourses();
    } catch (err) {
      setEditError(err instanceof ApiClientError ? err.message : "Failed to update course.");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleArchive = async (course: CourseSummaryDto) => {
    const endpoint = course.isActive
      ? `/admin/courses/${course.id}/archive`
      : `/admin/courses/${course.id}/activate`;
    try {
      await apiRequest<CourseSummaryDto>(endpoint, { method: "POST" });
      pushToast({
        title: course.isActive ? "Course archived" : "Course activated",
        description: `${course.code} — historical records preserved.`,
      });
      await fetchCourses();
    } catch (err) {
      pushToast({
        title: "Course status update failed",
        description: err instanceof ApiClientError ? err.message : "Request failed.",
      });
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Courses &amp; Enrollments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create courses, assign instructors, manage enrollments, and archive past terms.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Course
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Course Filters</CardTitle>
          <CardDescription>
            {coursesData
              ? `Showing ${coursesData.items.length} of ${coursesData.total} course(s)`
              : "Search by code, title, department, or filter by semester and status."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search courses"
              placeholder="Search code, title, department..."
              className="pl-8"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Input
            aria-label="Filter by semester"
            placeholder="Filter semester (e.g. Fall 2026)"
            value={semesterFilter}
            onChange={(e) => {
              setSemesterFilter(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="Filter course status"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as "ALL" | "true" | "false");
              setPage(1);
            }}
          >
            <option value="ALL">All Statuses</option>
            <option value="true">Active Courses</option>
            <option value="false">Archived Courses</option>
          </select>
        </CardContent>
      </Card>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Course</th>
                  <th className="px-4 py-3 font-medium">Teacher</th>
                  <th className="px-4 py-3 font-medium">Term</th>
                  <th className="px-4 py-3 font-medium">Enrolled</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={idx}>
                      <td className="px-4 py-3" colSpan={6}>
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))
                ) : coursesData && coursesData.items.length > 0 ? (
                  coursesData.items.map((course) => (
                    <tr key={course.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <Link
                          to={`/admin/courses/${course.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {course.code} — {course.title}
                        </Link>
                        {course.department && (
                          <p className="text-xs text-muted-foreground">{course.department}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{course.teacher.fullName}</p>
                        <p className="text-xs text-muted-foreground">{course.teacher.email}</p>
                      </td>
                      <td className="px-4 py-3 text-xs">{course.semester ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {course.activeEnrollmentCount}
                        {course.capacity !== null ? ` / ${course.capacity}` : ""}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={course.isActive ? "success" : "warning"}>
                          {course.isActive ? "ACTIVE" : "ARCHIVED"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/admin/courses/${course.id}`}>
                              <BookOpen className="h-3.5 w-3.5" />
                              Manage
                            </Link>
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => openEditDialog(course)}>
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleToggleArchive(course)}
                          >
                            {course.isActive ? (
                              <>
                                <Archive className="h-3.5 w-3.5" />
                                Archive
                              </>
                            ) : (
                              <>
                                <RotateCcw className="h-3.5 w-3.5" />
                                Activate
                              </>
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                      No courses found. Create a course to assign instructors and enroll students.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {coursesData && coursesData.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
              <span>
                Page {coursesData.page} of {coursesData.totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= coursesData.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Course Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Course</DialogTitle>
            <DialogDescription>
              Assign an active Teacher and configure term details.
            </DialogDescription>
          </DialogHeader>
          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {createError}
            </div>
          )}
          <form onSubmit={(e) => void handleCreateCourse(e)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="course-code">Course Code</Label>
                <Input
                  id="course-code"
                  placeholder="CS301"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="course-semester">Semester</Label>
                <Input
                  id="course-semester"
                  value={semester}
                  onChange={(e) => setSemester(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="course-title">Course Title</Label>
              <Input
                id="course-title"
                placeholder="Operating Systems"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="course-dept">Department</Label>
                <Input
                  id="course-dept"
                  placeholder="Computer Science"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="course-capacity">Capacity (optional)</Label>
                <Input
                  id="course-capacity"
                  type="number"
                  min={1}
                  placeholder="Unlimited"
                  value={capacity}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="course-teacher">Assigned Teacher</Label>
              <select
                id="course-teacher"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={teacherId}
                onChange={(e) => setTeacherId(e.target.value)}
                required
              >
                <option value="">Select active teacher...</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({t.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="course-description">Description</Label>
              <textarea
                id="course-description"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Course
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Course Dialog */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Course — {editTarget?.code}</DialogTitle>
            <DialogDescription>
              Update course metadata, capacity, or reassign instructor.
            </DialogDescription>
          </DialogHeader>
          {editError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {editError}
            </div>
          )}
          <form onSubmit={(e) => void handleSaveEdit(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-course-title">Title</Label>
              <Input
                id="edit-course-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                required
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="edit-course-sem">Semester</Label>
                <Input
                  id="edit-course-sem"
                  value={editSemester}
                  onChange={(e) => setEditSemester(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-course-cap">Capacity</Label>
                <Input
                  id="edit-course-cap"
                  type="number"
                  min={1}
                  value={editCapacity}
                  onChange={(e) => setEditCapacity(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-course-dept">Department</Label>
              <Input
                id="edit-course-dept"
                value={editDepartment}
                onChange={(e) => setEditDepartment(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-course-teacher">Assigned Teacher</Label>
              <select
                id="edit-course-teacher"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={editTeacherId}
                onChange={(e) => setEditTeacherId(e.target.value)}
                required
              >
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({t.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-course-desc">Description</Label>
              <textarea
                id="edit-course-desc"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingEdit}>
                {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
