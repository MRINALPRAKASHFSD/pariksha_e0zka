import {
  ExtensionStrikeMode,
  IntegrityEventType,
  ScreenSurfacePolicy,
} from "./enums.js";

export interface ProctoringPolicyConfig {
  requireWebcam: boolean;
  requireScreenShare: boolean;
  requireFullscreen: boolean;
  allowedScreenSurface: ScreenSurfacePolicy;
  detectTabSwitch: boolean;
  detectWindowBlur: boolean;
  detectFullscreenExit: boolean;
  detectCameraInterruption: boolean;
  detectScreenShareInterruption: boolean;
  restrictCopyPasteCut: boolean;
  restrictSelectAll: boolean;
  restrictRightClick: boolean;
  restrictTextSelection: boolean;
  detectClipboard: boolean;
  detectExtensionsHeuristic: boolean;
  extensionStrikeMode: ExtensionStrikeMode;
  monitorConnectionHeartbeat: boolean;
  monitorMediaHeartbeat: boolean;
  heartbeatIntervalSeconds: number;
  heartbeatTimeoutSeconds: number;
  heartbeatGraceSeconds: number;
  mediaGraceSeconds: number;
  dedupWindowSeconds: number;
  violationThreshold: number;
  pauseOnMediaLoss: boolean;
}

export const DEFAULT_PROCTORING_POLICY: ProctoringPolicyConfig = {
  requireWebcam: true,
  requireScreenShare: true,
  requireFullscreen: true,
  allowedScreenSurface: ScreenSurfacePolicy.ANY,
  detectTabSwitch: true,
  detectWindowBlur: true,
  detectFullscreenExit: true,
  detectCameraInterruption: true,
  detectScreenShareInterruption: true,
  restrictCopyPasteCut: true,
  restrictSelectAll: true,
  restrictRightClick: true,
  restrictTextSelection: true,
  detectClipboard: true,
  detectExtensionsHeuristic: true,
  extensionStrikeMode: ExtensionStrikeMode.AUDIT_ONLY,
  monitorConnectionHeartbeat: true,
  monitorMediaHeartbeat: true,
  heartbeatIntervalSeconds: 10,
  heartbeatTimeoutSeconds: 30,
  heartbeatGraceSeconds: 15,
  mediaGraceSeconds: 8,
  dedupWindowSeconds: 3,
  violationThreshold: 2,
  pauseOnMediaLoss: true,
};

/**
 * Related browser events emitted together for the same user action share a deduplication group
 * so a single tab switch triggering both blur and visibilitychange does not count as two strikes.
 */
export const EVENT_DEDUP_GROUPS: Record<IntegrityEventType, string> = {
  [IntegrityEventType.TAB_SWITCH]: "FOCUS_LOSS",
  [IntegrityEventType.WINDOW_BLUR]: "FOCUS_LOSS",
  [IntegrityEventType.FULLSCREEN_EXIT]: "FULLSCREEN_LOSS",
  [IntegrityEventType.CAMERA_INTERRUPTED]: "CAMERA_LOSS",
  [IntegrityEventType.SCREEN_SHARE_INTERRUPTED]: "SCREEN_SHARE_LOSS",
  [IntegrityEventType.COPY_ATTEMPT]: "CLIPBOARD_ACTION",
  [IntegrityEventType.PASTE_ATTEMPT]: "CLIPBOARD_ACTION",
  [IntegrityEventType.CUT_ATTEMPT]: "CLIPBOARD_ACTION",
  [IntegrityEventType.CLIPBOARD_EVENT]: "CLIPBOARD_ACTION",
  [IntegrityEventType.SELECT_ALL_ATTEMPT]: "SELECTION_ACTION",
  [IntegrityEventType.RIGHT_CLICK_ATTEMPT]: "CONTEXT_MENU_ACTION",
  [IntegrityEventType.EXTENSION_HEURISTIC]: "EXTENSION_HEURISTIC",
  [IntegrityEventType.HEARTBEAT_MISSED]: "HEARTBEAT_MISSED",
  [IntegrityEventType.PERMISSION_DENIED]: "PERMISSION_DENIED",
};

export const BROWSER_SECURITY_LIMITATIONS: readonly string[] = [
  "A website cannot enumerate every installed or active browser extension.",
  "Extension detection is strictly heuristic based on observable DOM or script anomalies and may trigger false positives from accessibility or legitimate browser tools.",
  "A website cannot reliably prevent operating-system-level screen recording or virtual display capture.",
  "A website cannot detect secondary physical devices such as phones, tablets, or external cameras.",
  "A website cannot intercept every system-level keyboard shortcut or OS window-switcher command.",
  "Browser media status and permission telemetry remain client-reported and may be manipulated by compromised clients.",
  "Webcam availability proves stream presence in the browser only and does not prove the absence of off-camera misconduct.",
  "Screen sharing does not guarantee every monitor or external application is continuously visible unless constrained and verified by platform capabilities.",
  "Window blur or focus loss can result from legitimate OS notifications or system dialogs.",
  "Network interruptions can trigger missing-heartbeat integrity events without intentional misconduct.",
  "Client-side lockdown controls are deterrents and monitoring mechanisms rather than equivalent to a hardware-isolated trusted examination browser.",
  "High-stakes examinations requiring stronger lockdown assurances may require a managed examination browser or institution-controlled workstations.",
];

export const UNPROCTORED_DEV_POLICY: ProctoringPolicyConfig = {
  requireWebcam: false,
  requireScreenShare: false,
  requireFullscreen: false,
  allowedScreenSurface: ScreenSurfacePolicy.ANY,
  detectTabSwitch: false,
  detectWindowBlur: false,
  detectFullscreenExit: false,
  detectCameraInterruption: false,
  detectScreenShareInterruption: false,
  restrictCopyPasteCut: false,
  restrictSelectAll: false,
  restrictRightClick: false,
  restrictTextSelection: false,
  detectClipboard: false,
  detectExtensionsHeuristic: false,
  extensionStrikeMode: ExtensionStrikeMode.AUDIT_ONLY,
  monitorConnectionHeartbeat: false,
  monitorMediaHeartbeat: false,
  heartbeatIntervalSeconds: 30,
  heartbeatTimeoutSeconds: 120,
  heartbeatGraceSeconds: 30,
  mediaGraceSeconds: 0,
  dedupWindowSeconds: 3,
  violationThreshold: 2,
  pauseOnMediaLoss: false,
};

export function requiresMandatoryProctoring(
  policy: Pick<ProctoringPolicyConfig, "requireWebcam" | "requireScreenShare" | "requireFullscreen">,
): boolean {
  return Boolean(policy.requireWebcam || policy.requireScreenShare || policy.requireFullscreen);
}

export interface ProctoringPreflightStatus {
  mode: "UNPROCTORED_DEV" | "PROCTORED_REQUIRED";
  proctoringEngineImplemented: boolean;
  canStartAttempt: boolean;
  requiresPreflightHandshake: boolean;
  blockingCode: "PROCTORING_UNAVAILABLE" | "UNPROCTORED_FORBIDDEN_IN_PRODUCTION" | null;
  blockingMessage: string | null;
  bannerLabel: string;
  requirements: {
    requireWebcam: boolean;
    requireScreenShare: boolean;
    requireFullscreen: boolean;
    allowedScreenSurface: ScreenSurfacePolicy;
    violationThreshold: number;
    heartbeatIntervalSeconds: number;
    heartbeatTimeoutSeconds: number;
    heartbeatGraceSeconds: number;
    mediaGraceSeconds: number;
    pauseOnMediaLoss: boolean;
  };
}

export interface ProctoringHeartbeatPayload {
  sequence: number;
  cameraActive: boolean;
  screenShareActive: boolean;
  fullscreenActive: boolean;
  connectionOnline: boolean;
  clientTimestamp?: string;
}

export interface ProctoringIntegrityReportPayload {
  clientEventId: string;
  eventType: IntegrityEventType;
  description?: string;
  confidence?: "OBSERVED" | "HEURISTIC" | "CLIENT_REPORTED";
  metadata?: Record<string, unknown>;
}
