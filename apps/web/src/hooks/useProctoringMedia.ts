import { useCallback, useEffect, useRef, useState } from "react";
import { ScreenSurfacePolicy } from "@pariksha/shared";

export type ClientMediaPermissionStatus = "UNKNOWN" | "GRANTED" | "DENIED" | "UNAVAILABLE";

export interface ProctoringMediaState {
  cameraSupported: boolean;
  screenShareSupported: boolean;
  fullscreenSupported: boolean;
  cameraStatus: ClientMediaPermissionStatus;
  screenStatus: ClientMediaPermissionStatus;
  cameraActive: boolean;
  screenShareActive: boolean;
  displaySurface: "monitor" | "window" | "browser" | "unknown";
  fullscreenActive: boolean;
  lastError: string | null;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
}

interface UseProctoringMediaOptions {
  enabled: boolean;
  onCameraInterrupted?: (reason: string) => void;
  onScreenShareInterrupted?: (reason: string) => void;
  onPermissionDenied?: (kind: "camera" | "screen", reason: string) => void;
  onFullscreenChanged?: (active: boolean) => void;
}

function normalizeDisplaySurface(raw?: string): "monitor" | "window" | "browser" | "unknown" {
  switch ((raw ?? "").toLowerCase()) {
    case "monitor":
      return "monitor";
    case "window":
      return "window";
    case "browser":
      return "browser";
    default:
      return "unknown";
  }
}

export function isSurfaceAllowed(
  surface: "monitor" | "window" | "browser" | "unknown",
  policy: ScreenSurfacePolicy,
): boolean {
  if (policy === ScreenSurfacePolicy.ANY) return true;
  if (surface === "unknown") return true;
  return surface.toUpperCase() === policy;
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped track errors during teardown
    }
  }
}

export function useProctoringMedia(options: UseProctoringMediaOptions) {
  const { enabled } = options;

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraInterruptedStreamRef = useRef<string | null>(null);
  const screenInterruptedStreamRef = useRef<string | null>(null);
  const handoffReleasedRef = useRef<boolean>(false);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const mediaDevicesAvailable =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function";
  const displayMediaAvailable =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getDisplayMedia === "function";
  const fullscreenAvailable =
    typeof document !== "undefined" && typeof document.documentElement?.requestFullscreen === "function";

  const [state, setState] = useState<ProctoringMediaState>({
    cameraSupported: mediaDevicesAvailable,
    screenShareSupported: displayMediaAvailable,
    fullscreenSupported: fullscreenAvailable,
    cameraStatus: mediaDevicesAvailable ? "UNKNOWN" : "UNAVAILABLE",
    screenStatus: displayMediaAvailable ? "UNKNOWN" : "UNAVAILABLE",
    cameraActive: false,
    screenShareActive: false,
    displaySurface: "unknown",
    fullscreenActive: typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false,
    lastError: null,
    cameraStream: null,
    screenStream: null,
  });

  const stopAllMediaTracks = useCallback(() => {
    stopStreamTracks(cameraStreamRef.current);
    stopStreamTracks(screenStreamRef.current);
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    cameraInterruptedStreamRef.current = null;
    screenInterruptedStreamRef.current = null;
    setState((prev) => {
      if (!prev.cameraActive && !prev.screenShareActive && !prev.cameraStream && !prev.screenStream) {
        return prev;
      }
      return {
        ...prev,
        cameraActive: false,
        screenShareActive: false,
        cameraStream: null,
        screenStream: null,
      };
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopAllMediaTracks();
    }
  }, [enabled, stopAllMediaTracks]);

  useEffect(() => {
    return () => {
      if (handoffReleasedRef.current) {
        return;
      }
      stopStreamTracks(cameraStreamRef.current);
      stopStreamTracks(screenStreamRef.current);
      cameraStreamRef.current = null;
      screenStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setState((prev) => ({ ...prev, fullscreenActive: active }));
      callbacksRef.current.onFullscreenChanged?.(active);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  const requestCamera = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!mediaDevicesAvailable) {
      const msg = "Camera capture API (getUserMedia) is unavailable in this browser context.";
      setState((prev) => ({
        ...prev,
        cameraStatus: "UNAVAILABLE",
        cameraActive: false,
        lastError: msg,
      }));
      return { ok: false, error: msg };
    }

    try {
      stopStreamTracks(cameraStreamRef.current);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 360 },
          facingMode: "user",
        },
        audio: false,
      });

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState !== "live") {
        stopStreamTracks(stream);
        const msg = "Camera stream obtained without a live video track.";
        setState((prev) => ({
          ...prev,
          cameraStatus: "UNAVAILABLE",
          cameraActive: false,
          cameraStream: null,
          lastError: msg,
        }));
        return { ok: false, error: msg };
      }

      cameraStreamRef.current = stream;
      cameraInterruptedStreamRef.current = null;

      const handleTrackEnded = () => {
        if (cameraStreamRef.current?.id !== stream.id) return;
        if (cameraInterruptedStreamRef.current === stream.id) return;
        cameraInterruptedStreamRef.current = stream.id;
        setState((prev) => ({
          ...prev,
          cameraActive: false,
          cameraStatus: "DENIED",
          lastError: "Camera track ended during monitored session.",
        }));
        callbacksRef.current.onCameraInterrupted?.("Camera video track ended unexpectedly.");
      };

      videoTrack.addEventListener("ended", handleTrackEnded, { once: true });

      setState((prev) => ({
        ...prev,
        cameraStatus: "GRANTED",
        cameraActive: true,
        cameraStream: stream,
        lastError: null,
      }));
      return { ok: true };
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      const denied = name === "NotAllowedError" || name === "PermissionDeniedError";
      const msg = denied
        ? "Camera permission was denied. Allow webcam access in your browser site settings."
        : err instanceof Error
          ? err.message
          : "Unable to initialize webcam stream.";
      setState((prev) => ({
        ...prev,
        cameraStatus: denied ? "DENIED" : "UNAVAILABLE",
        cameraActive: false,
        cameraStream: null,
        lastError: msg,
      }));
      if (denied) {
        callbacksRef.current.onPermissionDenied?.("camera", msg);
      }
      return { ok: false, error: msg };
    }
  }, [mediaDevicesAvailable]);

  const requestScreenShare = useCallback(
    async (
      allowedSurface: ScreenSurfacePolicy = ScreenSurfacePolicy.ANY,
    ): Promise<{ ok: boolean; displaySurface: "monitor" | "window" | "browser" | "unknown"; error?: string }> => {
      if (!displayMediaAvailable) {
        const msg = "Screen sharing API (getDisplayMedia) is unavailable in this browser context.";
        setState((prev) => ({
          ...prev,
          screenStatus: "UNAVAILABLE",
          screenShareActive: false,
          lastError: msg,
        }));
        return { ok: false, displaySurface: "unknown", error: msg };
      }

      try {
        stopStreamTracks(screenStreamRef.current);
        const videoConstraints: MediaTrackConstraints & { displaySurface?: string } = {};
        if (allowedSurface === ScreenSurfacePolicy.MONITOR) {
          videoConstraints.displaySurface = "monitor";
        } else if (allowedSurface === ScreenSurfacePolicy.WINDOW) {
          videoConstraints.displaySurface = "window";
        } else if (allowedSurface === ScreenSurfacePolicy.BROWSER) {
          videoConstraints.displaySurface = "browser";
        }

        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: Object.keys(videoConstraints).length > 0 ? videoConstraints : true,
          audio: false,
        });

        const track = stream.getVideoTracks()[0];
        if (!track || track.readyState !== "live") {
          stopStreamTracks(stream);
          const msg = "Screen share did not provide an active video track.";
          setState((prev) => ({
            ...prev,
            screenStatus: "UNAVAILABLE",
            screenShareActive: false,
            screenStream: null,
            lastError: msg,
          }));
          return { ok: false, displaySurface: "unknown", error: msg };
        }

        const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
        const surface = normalizeDisplaySurface(settings.displaySurface);

        if (!isSurfaceAllowed(surface, allowedSurface)) {
          stopStreamTracks(stream);
          const msg = `Policy requires sharing "${allowedSurface.toLowerCase()}", but "${surface}" was selected. Please re-share the required surface.`;
          setState((prev) => ({
            ...prev,
            screenStatus: "DENIED",
            screenShareActive: false,
            screenStream: null,
            displaySurface: surface,
            lastError: msg,
          }));
          return { ok: false, displaySurface: surface, error: msg };
        }

        screenStreamRef.current = stream;
        screenInterruptedStreamRef.current = null;

        const handleEnded = () => {
          if (screenStreamRef.current?.id !== stream.id) return;
          if (screenInterruptedStreamRef.current === stream.id) return;
          screenInterruptedStreamRef.current = stream.id;
          setState((prev) => ({
            ...prev,
            screenShareActive: false,
            screenStatus: "DENIED",
            screenStream: null,
            lastError: "Screen sharing stopped during the examination.",
          }));
          callbacksRef.current.onScreenShareInterrupted?.("Screen share track stopped by user or system.");
        };

        track.addEventListener("ended", handleEnded, { once: true });

        setState((prev) => ({
          ...prev,
          screenStatus: "GRANTED",
          screenShareActive: true,
          screenStream: stream,
          displaySurface: surface,
          lastError: null,
        }));
        return { ok: true, displaySurface: surface };
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        const denied = name === "NotAllowedError" || name === "PermissionDeniedError";
        const msg = denied
          ? "Screen sharing permission was cancelled or denied. Screen sharing is required to proceed."
          : err instanceof Error
            ? err.message
            : "Unable to initialize screen sharing.";
        setState((prev) => ({
          ...prev,
          screenStatus: denied ? "DENIED" : "UNAVAILABLE",
          screenShareActive: false,
          screenStream: null,
          lastError: msg,
        }));
        if (denied) {
          callbacksRef.current.onPermissionDenied?.("screen", msg);
        }
        return { ok: false, displaySurface: "unknown", error: msg };
      }
    },
    [displayMediaAvailable],
  );

  const requestFullscreen = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (typeof document === "undefined") {
      return { ok: false, error: "Document context unavailable." };
    }
    if (document.fullscreenElement) {
      setState((prev) => ({ ...prev, fullscreenActive: true, lastError: null }));
      return { ok: true };
    }
    if (!document.documentElement?.requestFullscreen) {
      const msg = "Fullscreen API is not supported in this browser.";
      setState((prev) => ({ ...prev, lastError: msg }));
      return { ok: false, error: msg };
    }
    try {
      await document.documentElement.requestFullscreen();
      setState((prev) => ({ ...prev, fullscreenActive: true, lastError: null }));
      return { ok: true };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Fullscreen request was blocked by the browser. Click the Fullscreen button directly.";
      setState((prev) => ({ ...prev, fullscreenActive: false, lastError: msg }));
      return { ok: false, error: msg };
    }
  }, []);

  const exitFullscreenIfActive = useCallback(async () => {
    if (typeof document !== "undefined" && document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch {
        // Best effort exit
      }
    }
  }, []);

  const syncTrackHealth = useCallback(() => {
    const camTracks = cameraStreamRef.current?.getVideoTracks() ?? [];
    const camOk = camTracks.some((t) => t.readyState === "live");
    const scrTracks = screenStreamRef.current?.getVideoTracks() ?? [];
    const scrOk = scrTracks.some((t) => t.readyState === "live");
    const fsOk = typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false;

    setState((prev) => ({
      ...prev,
      cameraActive: camOk,
      screenShareActive: scrOk,
      fullscreenActive: fsOk,
    }));

    return { cameraActive: camOk, screenShareActive: scrOk, fullscreenActive: fsOk };
  }, []);

  const releaseStreamsForHandoff = useCallback(() => {
    handoffReleasedRef.current = true;
    const result = {
      cameraStream: cameraStreamRef.current,
      screenStream: screenStreamRef.current,
      displaySurface: state.displaySurface,
    };
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    return result;
  }, [state.displaySurface]);

  const adoptStreams = useCallback(
    (entry: {
      cameraStream: MediaStream | null;
      screenStream: MediaStream | null;
      displaySurface: "monitor" | "window" | "browser" | "unknown";
    }) => {
      if (entry.cameraStream) {
        const camTrack = entry.cameraStream.getVideoTracks()[0];
        if (camTrack && camTrack.readyState === "live") {
          cameraStreamRef.current = entry.cameraStream;
          cameraInterruptedStreamRef.current = null;
          camTrack.addEventListener(
            "ended",
            () => {
              if (cameraStreamRef.current?.id !== entry.cameraStream?.id) return;
              if (cameraInterruptedStreamRef.current === entry.cameraStream?.id) return;
              cameraInterruptedStreamRef.current = entry.cameraStream?.id ?? null;
              setState((prev) => ({
                ...prev,
                cameraActive: false,
                cameraStatus: "DENIED",
                lastError: "Camera track ended during monitored session.",
              }));
              callbacksRef.current.onCameraInterrupted?.("Camera video track ended unexpectedly.");
            },
            { once: true },
          );
        } else {
          stopStreamTracks(entry.cameraStream);
        }
      }

      if (entry.screenStream) {
        const scrTrack = entry.screenStream.getVideoTracks()[0];
        if (scrTrack && scrTrack.readyState === "live") {
          screenStreamRef.current = entry.screenStream;
          screenInterruptedStreamRef.current = null;
          scrTrack.addEventListener(
            "ended",
            () => {
              if (screenStreamRef.current?.id !== entry.screenStream?.id) return;
              if (screenInterruptedStreamRef.current === entry.screenStream?.id) return;
              screenInterruptedStreamRef.current = entry.screenStream?.id ?? null;
              setState((prev) => ({
                ...prev,
                screenShareActive: false,
                screenStatus: "DENIED",
                screenStream: null,
                lastError: "Screen sharing stopped during the examination.",
              }));
              callbacksRef.current.onScreenShareInterrupted?.(
                "Screen share track stopped by user or system.",
              );
            },
            { once: true },
          );
        } else {
          stopStreamTracks(entry.screenStream);
        }
      }

      const camOk = Boolean(
        cameraStreamRef.current?.getVideoTracks().some((t) => t.readyState === "live"),
      );
      const scrOk = Boolean(
        screenStreamRef.current?.getVideoTracks().some((t) => t.readyState === "live"),
      );

      setState((prev) => ({
        ...prev,
        cameraActive: camOk,
        cameraStatus: camOk ? "GRANTED" : prev.cameraStatus,
        cameraStream: camOk ? cameraStreamRef.current : null,
        screenShareActive: scrOk,
        screenStatus: scrOk ? "GRANTED" : prev.screenStatus,
        screenStream: scrOk ? screenStreamRef.current : null,
        displaySurface: entry.displaySurface,
      }));
    },
    [],
  );

  return {
    state,
    requestCamera,
    requestScreenShare,
    requestFullscreen,
    exitFullscreenIfActive,
    stopAllMediaTracks,
    syncTrackHealth,
    releaseStreamsForHandoff,
    adoptStreams,
  };
}
