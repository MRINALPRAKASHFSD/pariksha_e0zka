import type { AttemptStatus, ExamStatus, QuestionType } from "@pariksha/shared";

export type UiBadgeVariant = "default" | "success" | "warning" | "destructive" | "outline";

export function formatQuestionTypeLabel(type: QuestionType): string {
  switch (type) {
    case "MULTIPLE_CHOICE":
      return "Multiple Choice";
    case "MULTIPLE_SELECT":
      return "Multiple Select";
    case "TRUE_FALSE":
      return "True / False";
    case "SUBJECTIVE_SHORT":
      return "Short Subjective";
    case "SUBJECTIVE_LONG":
      return "Long Subjective";
    case "SUBJECTIVE":
      return "Subjective";
    default:
      return type;
  }
}

export function getExamStatusBadgeVariant(status: ExamStatus): UiBadgeVariant {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "APPROVED":
      return "default";
    case "PENDING_APPROVAL":
    case "PAUSED":
      return "warning";
    case "REJECTED":
    case "CANCELLED":
      return "destructive";
    case "DRAFT":
    case "COMPLETED":
    case "ARCHIVED":
    default:
      return "outline";
  }
}

export function getAttemptStatusBadgeVariant(status: AttemptStatus): UiBadgeVariant {
  switch (status) {
    case "SUBMITTED":
      return "success";
    case "IN_PROGRESS":
      return "default";
    case "PAUSED":
    case "AUTO_SUBMITTED":
    case "EXPIRED":
      return "warning";
    case "TERMINATED":
      return "destructive";
    default:
      return "outline";
  }
}

export function toDateTimeLocalValue(iso?: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocalValue(localValue: string): string {
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date/time input");
  }
  return date.toISOString();
}

export function formatDateTimeShort(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}
