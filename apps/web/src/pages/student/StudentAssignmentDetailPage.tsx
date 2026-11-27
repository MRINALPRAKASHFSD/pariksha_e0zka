import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, Download, Loader2, Send } from "lucide-react";
import type { AssignmentSummaryDto, StudentSubmissionSummaryDto } from "@pariksha/shared";
import { ApiClientError, apiRequest, apiUploadWithProgress } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { FileDropzone } from "@/components/FileDropzone";
import { formatFileSize } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function StudentAssignmentDetailPage() {
  const { id: assignmentId } = useParams<{ id: string }>();
  const { pushToast } = useToast();

  const [assignment, setAssignment] = useState<AssignmentSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [files, setFiles] = useState<File[]>([]);
  const [notes, setNotes] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadAssignment = useCallback(async () => {
    if (!assignmentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<AssignmentSummaryDto>(`/student/assignments/${assignmentId}`);
      setAssignment(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load assignment.");
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    void loadAssignment();
  }, [loadAssignment]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!assignmentId) return;
    setSubmitError(null);

    if (files.length === 0) {
      setSubmitError("Please select at least one file to submit.");
      return;
    }

    const formData = new FormData();
    if (notes.trim()) formData.append("notes", notes.trim());
    for (const file of files) formData.append("files", file);

    setSubmitting(true);
    setUploadProgress(0);
    try {
      await apiUploadWithProgress<StudentSubmissionSummaryDto>(
        `/student/assignments/${assignmentId}/submit`,
        formData,
        (pct) => setUploadProgress(pct),
      );
      pushToast({
        title: "Assignment submitted",
        description: "Your submission has been recorded.",
      });
      setFiles([]);
      setNotes("");
      setUploadProgress(null);
      await loadAssignment();
    } catch (err) {
      setSubmitError(err instanceof ApiClientError ? err.message : "Submission failed.");
      setUploadProgress(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  }

  if (error || !assignment) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Button asChild variant="outline" size="sm">
          <Link to="/student/assignments">
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

  const sub = assignment.mySubmission;
  const now = new Date();
  const pastDue = now > new Date(assignment.dueAt);
  const pastLateCutoff =
    assignment.lateDueAt !== null && now > new Date(assignment.lateDueAt);
  const deadlineClosed = pastDue && (!assignment.allowLateSubmissions || pastLateCutoff);
  const canSubmit =
    !deadlineClosed &&
    (!sub || (assignment.allowResubmission && !sub.isGradePublished && sub.status !== "GRADED"));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/student/assignments">
            <ArrowLeft className="h-4 w-4" />
            All Assignments
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{assignment.title}</h1>
          <Badge variant={deadlineClosed ? "destructive" : "outline"}>
            Due {new Date(assignment.dueAt).toLocaleString()}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {assignment.courseCode} — {assignment.courseTitle} · Maximum Marks: {assignment.maxMarks}
        </p>
      </div>

      {/* Instructions & Attachments */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Instructions</CardTitle>
            <CardDescription>
              {assignment.allowResubmission
                ? "Resubmissions are permitted before grading."
                : "Single submission only (resubmissions disabled)."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {assignment.description && <p>{assignment.description}</p>}
            {assignment.instructions ? (
              <div className="rounded-md bg-muted/40 p-3 whitespace-pre-wrap text-xs">
                {assignment.instructions}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No additional instructions provided.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assignment Resources</CardTitle>
            <CardDescription>Authorized files uploaded by your instructor.</CardDescription>
          </CardHeader>
          <CardContent>
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
              <p className="text-sm text-muted-foreground">No attachments provided.</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Submission Confirmation & Published Grades */}
      {sub && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <CardTitle className="text-base">Your Submission</CardTitle>
              </div>
              <Badge variant={sub.isGradePublished ? "success" : "default"}>
                {sub.isGradePublished ? "GRADE PUBLISHED" : sub.status}
              </Badge>
            </div>
            <CardDescription>
              Submitted on {new Date(sub.submittedAt).toLocaleString()} · Submission #
              {sub.submissionCount}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {sub.attachments.length > 0 && (
              <ul className="space-y-2">
                {sub.attachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <span className="truncate font-medium">
                      {att.originalName} ({formatFileSize(att.sizeBytes)})
                    </span>
                    <Button asChild variant="outline" size="sm">
                      <a href={att.downloadUrl} download>
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {sub.notes && (
              <p className="text-xs text-muted-foreground">Notes: {sub.notes}</p>
            )}

            {sub.isGradePublished ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-1">
                <p className="text-sm font-semibold">
                  Awarded Marks: {sub.score} / {assignment.maxMarks}
                </p>
                {sub.feedback && (
                  <p className="text-xs text-foreground/90 whitespace-pre-wrap">
                    Feedback: {sub.feedback}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Marks and feedback will appear here once published by your instructor.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Submission Form */}
      {canSubmit ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {sub ? "Submit Updated Work" : "Upload & Submit Assignment"}
            </CardTitle>
            <CardDescription>
              Deadlines are strictly verified on the server using UTC timestamps.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {submitError && (
              <div
                role="alert"
                className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
              >
                {submitError}
              </div>
            )}
            <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
              <FileDropzone
                files={files}
                onFilesChange={setFiles}
                uploadProgress={uploadProgress}
                disabled={submitting}
                inputId="student-submission-files"
                label="Upload your assignment solution files"
              />

              <div className="space-y-1.5">
                <Label htmlFor="submission-notes">Submission Notes (optional)</Label>
                <textarea
                  id="submission-notes"
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder="Optional remarks for your instructor..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <Button type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    {sub ? "Resubmit Assignment" : "Submit Assignment"}
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-5 text-sm text-muted-foreground">
            {deadlineClosed
              ? "The submission window for this assignment has closed."
              : "Your submission has been finalized and cannot be replaced."}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
