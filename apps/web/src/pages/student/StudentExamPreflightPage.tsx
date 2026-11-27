import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Maximize2,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  XCircle,
} from "lucide-react";
import type {
  PreflightHandshakeReceiptDto,
  StudentExamAttemptDto,
  StudentExamPreflightContextDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { setPendingProctoringStreams } from "@/lib/activeProctoringStreams";
import { useToast } from "@/context/toast-context";
import { useProctoringMedia } from "@/hooks/useProctoringMedia";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function StudentExamPreflightPage() {
  const { examId } = useParams<{ examId: string }>();
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const [context, setContext] = useState<StudentExamPreflightContextDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectivityOk, setConnectivityOk] = useState<boolean>(false);
  const [checkingHealth, setCheckingHealth] = useState<boolean>(false);
  const [consentAccepted, setConsentAccepted] = useState<boolean>(false);
  const [launching, setLaunching] = useState<boolean>(false);

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const media = useProctoringMedia({ enabled: true });

  const checkConnectivity = useCallback(async () => {
    setCheckingHealth(true);
    try {
      await apiRequest<{ status: string }>("/health");
      setConnectivityOk(true);
    } catch {
      setConnectivityOk(false);
    } finally {
      setCheckingHealth(false);
    }
  }, []);

  const loadContext = useCallback(async () => {
    if (!examId) return;
    setLoading(true);
    setError(null);
    try {
      const dto = await apiRequest<StudentExamPreflightContextDto>(
        `/student/exams/${examId}/preflight`,
      );
      setContext(dto);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Unable to load examination preflight.");
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    void loadContext();
    void checkConnectivity();
  }, [loadContext, checkConnectivity]);

  useEffect(() => {
    const el = videoPreviewRef.current;
    if (!el) return;
    try {
      if (media.state.cameraStream) {
        el.srcObject = media.state.cameraStream;
        void el.play().catch(() => {
          // Autoplay may resolve asynchronously after browser attaches stream
        });
      } else {
        el.srcObject = null;
      }
    } catch {
      el.srcObject = null;
    }
  }, [media.state.cameraStream]);

  const handleLaunch = async () => {
    if (!examId || !context) return;
    setLaunching(true);
    try {
      const healthNow = await apiRequest<{ status: string }>("/health")
        .then(() => true)
        .catch(() => false);
      setConnectivityOk(healthNow);

      const snapshot = media.syncTrackHealth();

      const handshake = await apiRequest<PreflightHandshakeReceiptDto>(
        `/student/exams/${examId}/preflight`,
        {
          method: "POST",
          body: JSON.stringify({
            cameraStatus:
              context.policy.requireWebcam
                ? snapshot.cameraActive
                  ? "GRANTED"
                  : media.state.cameraStatus
                : "NOT_REQUIRED",
            screenShareStatus:
              context.policy.requireScreenShare
                ? snapshot.screenShareActive
                  ? "GRANTED"
                  : media.state.screenStatus
                : "NOT_REQUIRED",
            displaySurface: media.state.displaySurface,
            fullscreenStatus: context.policy.requireFullscreen
              ? snapshot.fullscreenActive
                ? "GRANTED"
                : media.state.fullscreenSupported
                  ? "DENIED"
                  : "UNAVAILABLE"
              : "NOT_REQUIRED",
            connectivityOk: healthNow,
            consentAccepted,
          }),
        },
      );

      const attempt = await apiRequest<StudentExamAttemptDto>(`/student/exams/${examId}/start`, {
        method: "POST",
        body: JSON.stringify({ preflightToken: handshake.preflightToken }),
      });

      const handedStreams = media.releaseStreamsForHandoff();
      setPendingProctoringStreams({
        attemptId: attempt.id,
        cameraStream: handedStreams.cameraStream,
        screenStream: handedStreams.screenStream,
        displaySurface: handedStreams.displaySurface,
      });

      navigate(`/student/exams/${examId}/attempt/${attempt.id}`, { replace: true });
    } catch (err) {
      pushToast({
        title: "Preflight verification incomplete",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please satisfy all hardware and permission checks before launching.",
      });
    } finally {
      setLaunching(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !context) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error ?? "Examination preflight context unavailable."}
        </div>
        <Button asChild variant="outline">
          <Link to="/student/exams">Back to Examinations</Link>
        </Button>
      </div>
    );
  }

  const policy = context.policy;
  const cameraReady = !policy.requireWebcam || media.state.cameraActive;
  const screenReady = !policy.requireScreenShare || media.state.screenShareActive;
  const fullscreenReady = !policy.requireFullscreen || media.state.fullscreenActive;
  const allChecksSatisfied =
    connectivityOk && consentAccepted && cameraReady && screenReady && fullscreenReady;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{context.courseCode}</Badge>
            <Badge variant="outline">Policy v{context.policyVersion}</Badge>
            <Badge variant={context.allowUnproctoredDev ? "warning" : "success"}>
              {context.allowUnproctoredDev ? "Dev Unproctored" : "Proctored Assessment"}
            </Badge>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Pre-Examination System &amp; Integrity Check
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {context.examTitle} · {context.durationMinutes} min · {context.totalMarks} marks
          </p>
        </div>

        <Button asChild variant="outline" onClick={() => media.stopAllMediaTracks()}>
          <Link to="/student/exams">Cancel &amp; Return</Link>
        </Button>
      </div>

      {/* Policy Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Required Proctoring &amp; Integrity Rules
          </CardTitle>
          <CardDescription>
            Server-authoritative enforcement rules active for this attempt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant={policy.requireWebcam ? "default" : "outline"}>
              Camera: {policy.requireWebcam ? "Required" : "Optional"}
            </Badge>
            <Badge variant={policy.requireScreenShare ? "default" : "outline"}>
              Screen Share:{" "}
              {policy.requireScreenShare
                ? `Required (${policy.allowedScreenSurface})`
                : "Optional"}
            </Badge>
            <Badge variant={policy.requireFullscreen ? "default" : "outline"}>
              Fullscreen: {policy.requireFullscreen ? "Required" : "Optional"}
            </Badge>
            <Badge variant="destructive">
              Auto-Submit Threshold: {policy.violationThreshold} strikes
            </Badge>
            <Badge variant="outline">
              Media Interruptions: {policy.pauseOnMediaLoss ? "Attempt pauses for recovery" : "Recorded telemetry"}
            </Badge>
          </div>

          {context.instructions && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs">
              <p className="font-semibold text-foreground">Instructor Examination Instructions</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{context.instructions}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Hardware & Permission Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* Camera Check */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Camera className="h-4 w-4" />
                Webcam Stream
              </span>
              {cameraReady ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <XCircle className="h-4 w-4 text-amber-600" />
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              {policy.requireWebcam
                ? "Local webcam video track is required (never uploaded or recorded)."
                : "Not required for this exam configuration."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="aspect-video overflow-hidden rounded-md border bg-muted">
              {media.state.cameraStream ? (
                <video
                  ref={videoPreviewRef}
                  autoPlay
                  playsInline
                  muted
                  aria-label="Local camera preview"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                  {policy.requireWebcam ? "Camera preview inactive" : "Webcam optional"}
                </div>
              )}
            </div>
            {policy.requireWebcam && (
              <Button
                type="button"
                className="w-full"
                variant={media.state.cameraActive ? "outline" : "default"}
                onClick={() => void media.requestCamera()}
              >
                {media.state.cameraActive ? "Re-verify Camera" : "Enable Camera"}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Screen Share Check */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Monitor className="h-4 w-4" />
                Screen Share
              </span>
              {screenReady ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <XCircle className="h-4 w-4 text-amber-600" />
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              {policy.requireScreenShare
                ? `Active screen capture required (Surface policy: ${policy.allowedScreenSurface}).`
                : "Not required for this exam configuration."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
              <p>
                Status: <strong>{media.state.screenStatus}</strong>
              </p>
              <p>
                Detected Surface: <strong>{media.state.displaySurface}</strong>
              </p>
              <p className="text-muted-foreground">
                Note: macOS browsers may require enabling Screen Recording permission in System Settings if prompt fails.
              </p>
            </div>
            {policy.requireScreenShare && (
              <Button
                type="button"
                className="w-full"
                variant={media.state.screenShareActive ? "outline" : "default"}
                onClick={() => void media.requestScreenShare(policy.allowedScreenSurface)}
              >
                {media.state.screenShareActive ? "Re-select Screen Share" : "Share Screen"}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Fullscreen & Connectivity */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Maximize2 className="h-4 w-4" />
                Fullscreen &amp; Network
              </span>
              {fullscreenReady && connectivityOk ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <XCircle className="h-4 w-4 text-amber-600" />
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Fullscreen lockdown and live server reachability verification.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span>Fullscreen Active</span>
                <Badge variant={fullscreenReady ? "success" : "warning"}>
                  {media.state.fullscreenActive ? "ACTIVE" : policy.requireFullscreen ? "REQUIRED" : "OPTIONAL"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <Wifi className="h-3.5 w-3.5" /> Server Link
                </span>
                <Badge variant={connectivityOk ? "success" : "destructive"}>
                  {connectivityOk ? "CONNECTED" : "OFFLINE"}
                </Badge>
              </div>
            </div>

            {policy.requireFullscreen && (
              <Button
                type="button"
                className="w-full"
                variant={media.state.fullscreenActive ? "outline" : "default"}
                onClick={() => void media.requestFullscreen()}
              >
                {media.state.fullscreenActive ? "Fullscreen Verified" : "Enter Fullscreen"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={checkingHealth}
              onClick={() => void checkConnectivity()}
            >
              {checkingHealth ? "Checking..." : "Re-test Server Connection"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {media.state.lastError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{media.state.lastError}</span>
        </div>
      )}

      {/* Privacy Notice & Limitations */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            Privacy Commitment &amp; Browser Technical Scope
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-xs text-muted-foreground">
          <p className="rounded-md border bg-muted/30 p-3 text-foreground">{context.privacyNotice}</p>
          <ul className="list-disc space-y-1 pl-5">
            {context.browserLimitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>

          <label className="flex items-start gap-2.5 pt-2 text-sm text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(e) => setConsentAccepted(e.target.checked)}
              className="mt-1 h-4 w-4"
            />
            <span>
              I understand the privacy commitment, two-strike auto-submission rule, and technical rules above, and consent to live session proctoring telemetry for this examination attempt.
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="text-xs text-muted-foreground">
          {!context.preflight.canStartAttempt
            ? context.preflight.blockingMessage
            : allChecksSatisfied
              ? "All preflight checks passed. A single-use server handshake will be issued on launch."
              : "Complete all required camera, screen share, fullscreen, and consent checks to launch."}
        </div>
        <Button
          size="lg"
          disabled={!allChecksSatisfied || !context.preflight.canStartAttempt || launching}
          onClick={() => void handleLaunch()}
        >
          {launching ? "Verifying Handshake..." : "Launch Proctored Examination"}
        </Button>
      </div>
    </div>
  );
}
