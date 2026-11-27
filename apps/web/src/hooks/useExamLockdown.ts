import { useEffect, useRef } from "react";
import {
  IntegrityEventConfidence,
  IntegrityEventType,
  type ProctoringPolicyConfig,
} from "@pariksha/shared";

export interface LockdownViolationPayload {
  clientEventId: string;
  eventType: IntegrityEventType;
  description: string;
  confidence: IntegrityEventConfidence;
  metadata?: Record<string, unknown>;
}

interface UseExamLockdownOptions {
  enabled: boolean;
  paused: boolean;
  policy: ProctoringPolicyConfig | null;
  onViolation: (payload: LockdownViolationPayload) => void;
  onNotice?: (message: string) => void;
}

const KNOWN_EXTENSION_SELECTORS = [
  "grammarly-extension",
  "grammarly-desktop-integration",
  "[data-new-gr-c-s-check-loaded]",
  "[data-gr-ext-installed]",
  "[id*='chatgpt']",
  "[id*='copilot-overlay']",
  "[class*='grammarly']",
];

function createClientEventId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2, 12)}`;
}

function isEditableResponseElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "TEXTAREA" || (tag === "INPUT" && (target as HTMLInputElement).type === "text");
}

export function useExamLockdown({
  enabled,
  paused,
  policy,
  onViolation,
  onNotice,
}: UseExamLockdownOptions) {
  const onViolationRef = useRef(onViolation);
  const onNoticeRef = useRef(onNotice);
  onViolationRef.current = onViolation;
  onNoticeRef.current = onNotice;

  const recentEmitRef = useRef<Record<string, number>>({});
  const extensionDetectedKeysRef = useRef<Set<string>>(new Set());
  const wasFullscreenRef = useRef<boolean>(
    typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false,
  );

  const emitOnceWithin = (
    throttleKey: string,
    windowMs: number,
    payload: Omit<LockdownViolationPayload, "clientEventId">,
  ) => {
    const now = Date.now();
    const prev = recentEmitRef.current[throttleKey] ?? 0;
    if (now - prev < windowMs) return;
    recentEmitRef.current[throttleKey] = now;
    onViolationRef.current({
      ...payload,
      clientEventId: createClientEventId(),
    });
  };

  const detectTabSwitch = Boolean(policy?.detectTabSwitch);
  const detectWindowBlur = Boolean(policy?.detectWindowBlur);
  const detectFullscreenExit = Boolean(policy?.detectFullscreenExit);
  const restrictCopyPasteCut = Boolean(policy?.restrictCopyPasteCut);
  const restrictSelectAll = Boolean(policy?.restrictSelectAll);
  const restrictRightClick = Boolean(policy?.restrictRightClick);
  const restrictTextSelection = Boolean(policy?.restrictTextSelection);
  const detectClipboard = Boolean(policy?.detectClipboard);
  const detectExtensionsHeuristic = Boolean(policy?.detectExtensionsHeuristic);

  useEffect(() => {
    if (!enabled || paused || !policy) {
      return;
    }

    wasFullscreenRef.current = Boolean(document.fullscreenElement);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && detectTabSwitch) {
        emitOnceWithin("TAB_SWITCH", 400, {
          eventType: IntegrityEventType.TAB_SWITCH,
          description: "Candidate switched away from the examination browser tab.",
          confidence: IntegrityEventConfidence.OBSERVED,
          metadata: { visibilityState: document.visibilityState },
        });
      }
    };

    const handleWindowBlur = () => {
      if (document.visibilityState === "hidden") {
        // Let visibilitychange handle tab switch cleanly without double firing blur
        return;
      }
      if (detectWindowBlur) {
        emitOnceWithin("WINDOW_BLUR", 400, {
          eventType: IntegrityEventType.WINDOW_BLUR,
          description: "Examination browser window lost operating-system focus.",
          confidence: IntegrityEventConfidence.OBSERVED,
        });
      }
    };

    const handleFullscreenChange = () => {
      const nowFs = Boolean(document.fullscreenElement);
      if (wasFullscreenRef.current && !nowFs && detectFullscreenExit) {
        emitOnceWithin("FULLSCREEN_EXIT", 400, {
          eventType: IntegrityEventType.FULLSCREEN_EXIT,
          description: "Candidate exited fullscreen mode while the examination remained active.",
          confidence: IntegrityEventConfidence.OBSERVED,
        });
      }
      wasFullscreenRef.current = nowFs;
    };

    const handleCopy = (e: ClipboardEvent) => {
      if (!restrictCopyPasteCut && !detectClipboard) return;
      if (restrictCopyPasteCut) {
        e.preventDefault();
        onNoticeRef.current?.("Clipboard copy is disabled during this examination.");
      }
      emitOnceWithin("CLIPBOARD_COPY", 300, {
        eventType: IntegrityEventType.COPY_ATTEMPT,
        description: "Clipboard copy attempt blocked inside examination view.",
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    };

    const handleCut = (e: ClipboardEvent) => {
      if (!restrictCopyPasteCut && !detectClipboard) return;
      if (restrictCopyPasteCut) {
        e.preventDefault();
        onNoticeRef.current?.("Clipboard cut is disabled during this examination.");
      }
      emitOnceWithin("CLIPBOARD_CUT", 300, {
        eventType: IntegrityEventType.CUT_ATTEMPT,
        description: "Clipboard cut attempt blocked inside examination view.",
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    };

    const handlePaste = (e: ClipboardEvent) => {
      if (!restrictCopyPasteCut && !detectClipboard) return;
      if (restrictCopyPasteCut) {
        e.preventDefault();
        onNoticeRef.current?.("Clipboard paste is disabled during this examination.");
      }
      emitOnceWithin("CLIPBOARD_PASTE", 300, {
        eventType: IntegrityEventType.PASTE_ATTEMPT,
        description: "Clipboard paste attempt blocked inside examination view.",
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (!restrictRightClick) return;
      e.preventDefault();
      onNoticeRef.current?.("Context menu / right-click is disabled during the examination.");
      emitOnceWithin("RIGHT_CLICK", 500, {
        eventType: IntegrityEventType.RIGHT_CLICK_ATTEMPT,
        description: "Context menu (right-click) was attempted inside examination workspace.",
        confidence: IntegrityEventConfidence.OBSERVED,
      });
    };

    const handleSelectStart = (e: Event) => {
      if (!restrictTextSelection) return;
      if (isEditableResponseElement(e.target)) {
        // Allow normal editing cursor/selection inside subjective answer textarea
        return;
      }
      e.preventDefault();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if ((key === "c" || key === "x" || key === "v") && (restrictCopyPasteCut || detectClipboard)) {
        if (restrictCopyPasteCut) {
          e.preventDefault();
        }
        const eventType =
          key === "c"
            ? IntegrityEventType.COPY_ATTEMPT
            : key === "x"
              ? IntegrityEventType.CUT_ATTEMPT
              : IntegrityEventType.PASTE_ATTEMPT;
        const label = key === "c" ? "copy" : key === "x" ? "cut" : "paste";
        onNoticeRef.current?.(`Keyboard shortcut Ctrl/Cmd+${key.toUpperCase()} (${label}) is restricted.`);
        emitOnceWithin(`CLIPBOARD_${label.toUpperCase()}`, 300, {
          eventType,
          description: `Restricted keyboard ${label} shortcut detected.`,
          confidence: IntegrityEventConfidence.OBSERVED,
        });
        return;
      }

      if (key === "a" && restrictSelectAll) {
        if (isEditableResponseElement(e.target)) {
          // Do not break normal editing in subjective fields unless external copy attempted
          return;
        }
        e.preventDefault();
        onNoticeRef.current?.("Select-all shortcut is disabled outside answer text fields.");
        emitOnceWithin("SELECT_ALL", 500, {
          eventType: IntegrityEventType.SELECT_ALL_ATTEMPT,
          description: "Select-all shortcut blocked on examination content.",
          confidence: IntegrityEventConfidence.OBSERVED,
        });
      }
    };

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("copy", handleCopy);
    document.addEventListener("cut", handleCut);
    document.addEventListener("paste", handlePaste);
    document.addEventListener("contextmenu", handleContextMenu);
    document.addEventListener("selectstart", handleSelectStart);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("beforeunload", handleBeforeUnload);

    let observer: MutationObserver | null = null;
    const scanHeuristicDom = () => {
      if (!detectExtensionsHeuristic) return;

      for (const selector of KNOWN_EXTENSION_SELECTORS) {
        const match = document.querySelector(selector);
        if (match) {
          const key = `selector:${selector}`;
          if (!extensionDetectedKeysRef.current.has(key)) {
            extensionDetectedKeysRef.current.add(key);
            emitOnceWithin(`EXT_${key}`, 1000, {
              eventType: IntegrityEventType.EXTENSION_HEURISTIC,
              description:
                "Heuristic DOM signature associated with an injected browser extension overlay was observed (not definitive proof).",
              confidence: IntegrityEventConfidence.HEURISTIC,
              metadata: {
                indicator: "dom_selector",
                signature: selector,
                tagName: match.tagName,
              },
            });
          }
        }
      }

      const extScripts = Array.from(document.querySelectorAll("script[src]")).filter((el) => {
        const src = el.getAttribute("src") ?? "";
        return src.startsWith("chrome-extension://") || src.startsWith("moz-extension://");
      });
      if (extScripts.length > 0 && !extensionDetectedKeysRef.current.has("ext-script")) {
        extensionDetectedKeysRef.current.add("ext-script");
        emitOnceWithin("EXT_SCRIPT", 1000, {
          eventType: IntegrityEventType.EXTENSION_HEURISTIC,
          description:
            "Heuristic script URI pattern matching a browser extension injection was observed (not definitive proof).",
          confidence: IntegrityEventConfidence.HEURISTIC,
          metadata: {
            indicator: "injected_script",
            count: extScripts.length,
          },
        });
      }
    };

    if (detectExtensionsHeuristic && typeof MutationObserver !== "undefined") {
      scanHeuristicDom();
      observer = new MutationObserver((mutations) => {
        const hasBodyOrHeadChildAdditions = mutations.some(
          (m) =>
            m.type === "childList" &&
            m.addedNodes.length > 0 &&
            (m.target === document.documentElement ||
              m.target === document.body ||
              m.target === document.head),
        );
        if (hasBodyOrHeadChildAdditions) {
          scanHeuristicDom();
        }
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("cut", handleCut);
      document.removeEventListener("paste", handlePaste);
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("selectstart", handleSelectStart);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [
    enabled,
    paused,
    policy,
    detectTabSwitch,
    detectWindowBlur,
    detectFullscreenExit,
    restrictCopyPasteCut,
    restrictSelectAll,
    restrictRightClick,
    restrictTextSelection,
    detectClipboard,
    detectExtensionsHeuristic,
  ]);
}
