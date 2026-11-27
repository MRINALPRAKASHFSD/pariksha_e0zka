import type { Express } from "express";
import type request from "supertest";
import { futureWindowIso, loginAs, type SeededPhase4Actors } from "./phase4TestHelpers.js";

export async function createActiveProctoredExam(options: {
  app: Express;
  actors: SeededPhase4Actors;
  allowUnproctoredDev?: boolean;
  durationMinutes?: number;
  maxAttempts?: number;
  title?: string;
}) {
  const teacher = await loginAs(options.app, options.actors.teacher.email);
  const admin = await loginAs(options.app, options.actors.admin.email);
  const win = futureWindowIso(-60_000, 3_600_000);

  const createRes = await teacher.agent
    .post("/api/v1/teacher/exams")
    .set("X-CSRF-Token", teacher.csrf)
    .send({
      courseId: options.actors.course.id,
      title: options.title ?? "Phase 5 Monitored Exam",
      instructions: "Camera, screen share, and fullscreen required.",
      durationMinutes: options.durationMinutes ?? 45,
      passingMarks: 2,
      maxAttempts: options.maxAttempts ?? 2,
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
    });
  if (createRes.status !== 201) {
    throw new Error(`Failed creating exam: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }
  const examId = createRes.body.data.id as string;

  const q1 = await teacher.agent
    .post(`/api/v1/teacher/exams/${examId}/questions`)
    .set("X-CSRF-Token", teacher.csrf)
    .send({
      type: "MULTIPLE_CHOICE",
      prompt: "Which component enforces strike auto-submission?",
      explanation: "Server transaction locks and enforces strike rules.",
      marks: 3,
      options: [
        { text: "Backend PostgreSQL transaction", isCorrect: true },
        { text: "Browser localStorage", isCorrect: false },
      ],
    });

  const q2 = await teacher.agent
    .post(`/api/v1/teacher/exams/${examId}/questions`)
    .set("X-CSRF-Token", teacher.csrf)
    .send({
      type: "SUBJECTIVE_SHORT",
      prompt: "Explain why timers are server-authoritative.",
      marks: 2,
    });

  const submitApproval = await teacher.agent
    .post(`/api/v1/teacher/exams/${examId}/submit-for-approval`)
    .set("X-CSRF-Token", teacher.csrf);
  if (submitApproval.status !== 200) {
    throw new Error(`Submit approval failed: ${submitApproval.status}`);
  }

  const approveRes = await admin.agent
    .post(`/api/v1/admin/exams/${examId}/approve`)
    .set("X-CSRF-Token", admin.csrf)
    .send({
      activateImmediately: true,
      allowUnproctoredDev: options.allowUnproctoredDev ?? false,
    });
  if (approveRes.status !== 200) {
    throw new Error(`Approve failed: ${approveRes.status} ${JSON.stringify(approveRes.body)}`);
  }

  return {
    examId,
    q1Id: q1.body.data.question.id as string,
    q1CorrectOptionId: q1.body.data.question.options[0].id as string,
    q2Id: q2.body.data.question.id as string,
    admin,
    teacher,
  };
}

export async function issuePreflightAndStartAttempt(params: {
  student: { agent: ReturnType<typeof request.agent>; csrf: string };
  examId: string;
  cameraStatus?: "GRANTED" | "DENIED" | "UNAVAILABLE" | "NOT_REQUIRED";
  screenShareStatus?: "GRANTED" | "DENIED" | "UNAVAILABLE" | "NOT_REQUIRED";
  displaySurface?: "monitor" | "window" | "browser" | "unknown";
  fullscreenActive?: boolean;
}) {
  const preRes = await params.student.agent
    .post(`/api/v1/student/exams/${params.examId}/preflight`)
    .set("X-CSRF-Token", params.student.csrf)
    .send({
      cameraStatus: params.cameraStatus ?? "GRANTED",
      screenShareStatus: params.screenShareStatus ?? "GRANTED",
      displaySurface: params.displaySurface ?? "monitor",
      fullscreenStatus: params.fullscreenActive === false ? "DENIED" : "GRANTED",
      connectivityOk: true,
      consentAccepted: true,
    });
  if (preRes.status !== 201) {
    throw new Error(`Preflight failed: ${preRes.status} ${JSON.stringify(preRes.body)}`);
  }

  const startRes = await params.student.agent
    .post(`/api/v1/student/exams/${params.examId}/start`)
    .set("X-CSRF-Token", params.student.csrf)
    .send({ preflightToken: preRes.body.data.preflightToken });
  if (startRes.status !== 201) {
    throw new Error(`Start failed: ${startRes.status} ${JSON.stringify(startRes.body)}`);
  }

  return {
    preflight: preRes.body.data,
    attempt: startRes.body.data,
    attemptId: startRes.body.data.id as string,
  };
}
