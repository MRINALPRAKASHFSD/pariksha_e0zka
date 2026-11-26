import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle, Download, Loader2, Upload } from "lucide-react";
import type { AssignmentSummaryDto, TeacherSubmissionItemDto } from "@pariksha/shared";
import { ApiClientError, apiRequest, apiUploadWithProgress } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { FileDropzone } from "@/components/FileDropzone";
import { formatFileSize } from "@/lib/utils";
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

export function TeacherAssignmentDetailPage() {
  const { id: assignmentId } = useParams<{ id: string }>();
  const { pushToast } = useToast();

  const [assignment, setAssignment] = useState<AssignmentSummaryDto | null>(null);
  const [submissions, setSubmissions] = useState<TeacherSubmissionItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Additional attachment upload
  const [extraFiles, setExtraFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  // Grading dialog
  const [gradingTarget, setGradingTarget] = useState<TeacherSubmissionItemDto | null>(null);
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState("");
  const [publishGrade, setPublishGrade] = useState(true);
  const [grading, setGrading] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!assignmentId) return;
    setLoading(true);
    setError(null);
    try {
      const [aRes, sRes] = await Promise.all([
        apiRequest<AssignmentSummaryDto>(`/teacher/assignments/${assignmentId}`),
        apiRequest<TeacherSubmissionItemDto[]>(`/teacher/assignments/${assignmentId}/submissions`),
      ]);
      setAssignment(aRes);
      setSubmissions(sRes);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load assignment.");
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleUploadAttachments = async () => {
    if (!assignmentId || extraFiles.length === 0) return;
    const formData = new FormData();
    for (const file of extraFiles) formData.append("attachments", file);

    setUploading(true);
    setUploadProgress(0);
    try {
      await apiUploadWithProgress<AssignmentSummaryDto>(
        `/teacher/assignments/${assignmentId}/attachments`,
        formData,
        (pct) => setUploadProgress(pct),
      );
      pushToast({ title: "Attachments uploaded", description: `${extraFiles.length} file(s) added.` });
      setExtraFiles([]);
      setUploadProgress(null);
      await loadDetail();
    } catch (err) {
      pushToast({
        title: "Upload failed",
        description: err instanceof ApiClientError ? err.message : "Failed to upload files.",
      });
      setUploadProgress(null);
    } finally {
      setUploading(false);
    }
  };

  const handlePublishAssignment = async () => {
    if (!assignmentId) return;
    try {
      await apiRequest<AssignmentSummaryDto>(`/teacher/assignments/${assignmentId}/publish`, {
        method: "POST",
      });
      pushToast({ title: "Assignment published", description: assignment?.title });
      await loadDetail();
    } catch (err) {
      pushToast({
        title: "Publish failed",
        description: err instanceof ApiClientError ? err.message : "Failed to publish.",
      });
    }
  };

  const openGradeDialog = (sub: TeacherSubmissionItemDto) => {
    setGradingTarget(sub);
    setScore(sub.score !== null ? String(sub.score) : "");
    setFeedback(sub.feedback ?? "");
    setPublishGrade(true);
    setGradeError(null);
  };

  const handleSaveGrade = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!gradingTarget) return;
    setGradeError(null);
    setGrading(true);
    try {
      await apiRequest<TeacherSubmissionItemDto>(
        `/teacher/assignment-submissions/${gradingTarget.id}/grade`,
        {
          method: "POST",
          body: JSON.stringify({
            score: Number(score),
            feedback: feedback.trim() || undefined,
            publishGrade,
          }),
        },
      );
      pushToast({
        title: publishGrade ? "Grade saved & published" : "Grade saved",
        description: gradingTarget.student.fullName,
      });
      setGradingTarget(null);
      await loadDetail();
    } catch (err) {
      setGradeError(err instanceof ApiClientError ? err.message : "Failed to save grade.");
    } finally {
      setGrading(false);
    }
  };

  const handlePublishGradeOnly = async (sub: TeacherSubmissionItemDto) => {
    try {
      await apiRequest<TeacherSubmissionItemDto>(
        `/teacher/assignment-submissions/${sub.id}/publish-grade`,
        { method: "POST" },
      );
      pushToast({ title: "Grade published to student", description: sub.student.fullName });
      await loadDetail();
    } catch (err) {
      pushToast({
        title: "Publish failed",
        description: err instanceof ApiClientError ? err.message : "Unable to publish grade.",
      });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (error || !assignment) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/teacher/assignments">
            <ArrowLeft className="h-4 w-4" />
            Back to Assignments
          </Link>
        </Button>
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Assignment not found."}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link to="/teacher/assignments">
              <ArrowLeft className="h-4 w-4" />
              All Assignments
            </Link>
          </Button>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{assignment.title}</h1>
            <Badge variant={assignment.status === "PUBLISHED" ? "success" : "outline"}>
              {assignment.status}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {assignment.courseCode} — {assignment.courseTitle} · Max {assignment.maxMarks} marks ·
            Due {new Date(assignment.dueAt).toLocaleString()}
          </p>
        </div>

        {assignment.status === "DRAFT" && (
          <Button onClick={() => void handlePublishAssignment()}>
            <CheckCircle className="h-4 w-4" />
            Publish Assignment
          </Button>
        )}
      </div>

      {/* Instructions & Attachments */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details &amp; Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {assignment.description && <p>{assignment.description}</p>}
            {assignment.instructions && (
              <div className="rounded-md bg-muted/40 p-3 whitespace-pre-wrap text-xs">
                {assignment.instructions}
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">
                Late submissions: {assignment.allowLateSubmissions ? "Allowed" : "Closed on dueAt"}
              </Badge>
              <Badge variant="outline">
                Resubmission: {assignment.allowResubmission ? "Allowed" : "Single submission"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assignment Attachments</CardTitle>
            <CardDescription>Files available for enrolled students to download.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {assignment.attachments.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {assignment.attachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{att.originalName}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(att.sizeBytes)}</p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a href={att.downloadUrl} download>
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No attachments uploaded yet.</p>
            )}

            {assignment.status !== "ARCHIVED" && (
              <div className="space-y-2 pt-2 border-t">
                <FileDropzone
                  files={extraFiles}
                  onFilesChange={setExtraFiles}
                  uploadProgress={uploadProgress}
                  disabled={uploading}
                  inputId="teacher-extra-attachments"
                  label="Add additional attachments"
                />
                {extraFiles.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => void handleUploadAttachments()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    Upload Attachment(s)
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Student Submissions Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Student Submissions ({submissions.length})</CardTitle>
          <CardDescription>
            Download student work, allocate marks, provide feedback, and publish grades.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Student</th>
                  <th className="px-4 py-3 font-medium">Files &amp; Notes</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Grade</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {submissions.length > 0 ? (
                  submissions.map((sub) => (
                    <tr key={sub.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{sub.student.fullName}</p>
                        <p className="text-xs text-muted-foreground">{sub.student.email}</p>
                        <p className="text-[11px] text-muted-foreground">
                          Submitted {new Date(sub.submittedAt).toLocaleString()}
                        </p>
                      </td>
                      <td className="px-4 py-3 space-y-1">
                        {sub.attachments.map((att) => (
                          <div key={att.id}>
                            <a
                              href={att.downloadUrl}
                              download
                              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              <Download className="h-3 w-3" />
                              {att.originalName} ({formatFileSize(att.sizeBytes)})
                            </a>
                          </div>
                        ))}
                        {sub.notes && (
                          <p className="text-xs text-muted-foreground">Note: {sub.notes}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            sub.status === "GRADED"
                              ? "success"
                              : sub.status === "LATE"
                                ? "warning"
                                : "default"
                          }
                        >
                          {sub.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {sub.score !== null ? (
                          <div>
                            <p className="font-semibold">
                              {sub.score} / {assignment.maxMarks}
                            </p>
                            <Badge
                              variant={sub.isGradePublished ? "success" : "outline"}
                              className="mt-1"
                            >
                              {sub.isGradePublished ? "Published" : "Draft Grade"}
                            </Badge>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Ungraded</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right space-x-1.5">
                        <Button variant="outline" size="sm" onClick={() => openGradeDialog(sub)}>
                          {sub.score !== null ? "Update Grade" : "Grade"}
                        </Button>
                        {sub.status === "GRADED" && !sub.isGradePublished && (
                          <Button size="sm" onClick={() => void handlePublishGradeOnly(sub)}>
                            Publish Grade
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No students have submitted this assignment yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Grade Submission Dialog */}
      <Dialog open={Boolean(gradingTarget)} onOpenChange={(open) => !open && setGradingTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grade Submission — {gradingTarget?.student.fullName}</DialogTitle>
            <DialogDescription>
              Allocate marks out of {assignment.maxMarks} and provide written feedback.
            </DialogDescription>
          </DialogHeader>
          {gradeError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {gradeError}
            </div>
          )}
          <form onSubmit={(e) => void handleSaveGrade(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="grade-score">Score (0 – {assignment.maxMarks})</Label>
              <Input
                id="grade-score"
                type="number"
                min={0}
                max={assignment.maxMarks}
                step="0.5"
                value={score}
                onChange={(e) => setScore(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="grade-feedback">Written Feedback</Label>
              <textarea
                id="grade-feedback"
                rows={4}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={publishGrade}
                onChange={(e) => setPublishGrade(e.target.checked)}
              />
              Publish marks &amp; feedback to student immediately
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setGradingTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={grading}>
                {grading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Grade
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
