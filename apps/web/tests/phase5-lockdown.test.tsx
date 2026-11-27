import React, { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROCTORING_POLICY,
  ExtensionStrikeMode,
  IntegrityEventType,
  ScreenSurfacePolicy,
  type ProctoringPolicyConfig,
} from "@pariksha/shared";
import { useExamLockdown, type LockdownViolationPayload } from "../src/hooks/useExamLockdown";
import { useProctoringMedia } from "../src/hooks/useProctoringMedia";

function buildPolicy(overrides: Partial<ProctoringPolicyConfig> = {}): ProctoringPolicyConfig {
  return {
    ...DEFAULT_PROCTORING_POLICY,
    extensionStrikeMode: ExtensionStrikeMode.AUDIT_ONLY,
    ...overrides,
  };
}

function LockdownHarness({
  enabled,
  paused = false,
  policy,
  onViolation,
}: {
  enabled: boolean;
  paused?: boolean;
  policy: ProctoringPolicyConfig;
  onViolation: (v: LockdownViolationPayload) => void;
}) {
  const [text, setText] = useState("");
  useExamLockdown({ enabled, paused, policy, onViolation });
  return (
    <div>
      <div data-testid="prompt-area">Read prompt carefully.</div>
      <textarea
        aria-label="Subjective Answer"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

describe("Phase 5 Browser Lockdown & Media Hooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("StrictMode-safe registration avoids duplicate strike emissions and removes listeners cleanly on unmount", () => {
    const violations: LockdownViolationPayload[] = [];
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");

    const { unmount } = render(
      <StrictMode>
        <LockdownHarness
          enabled
          policy={buildPolicy()}
          onViolation={(v) => violations.push(v)}
        />
      </StrictMode>,
    );

    const prompt = screen.getByTestId("prompt-area");
    fireEvent.contextMenu(prompt);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.eventType).toBe(IntegrityEventType.RIGHT_CLICK_ATTEMPT);

    // Subjective field normal typing remains uninterrupted
    const textarea = screen.getByLabelText("Subjective Answer");
    fireEvent.change(textarea, { target: { value: "Normal exam answer text" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Normal exam answer text");

    // Ctrl+V blocked & emits single PASTE_ATTEMPT
    fireEvent.keyDown(prompt, { key: "v", ctrlKey: true });
    expect(violations).toHaveLength(2);
    expect(violations[1]?.eventType).toBe(IntegrityEventType.PASTE_ATTEMPT);

    // Unmount detaches all listeners cleanly
    unmount();
    fireEvent.contextMenu(document.body);
    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });
    expect(violations).toHaveLength(2);
    expect(localSetSpy).not.toHaveBeenCalled();
  });

  it("stops all camera and screen tracks when disabled or unmounted and deduplicates ended-track triggers", async () => {
    const camStop = vi.fn();
    const screenStop = vi.fn();
    const listeners: Record<string, Array<() => void>> = { cam: [], screen: [] };

    const makeTrack = (kind: "cam" | "screen", stopFn: () => void, surface?: string) => ({
      kind: "video",
      readyState: "live",
      stop: stopFn,
      getSettings: () => (surface ? { displaySurface: surface } : {}),
      addEventListener: (_evt: string, fn: () => void) => {
        listeners[kind]!.push(fn);
      },
    });

    const camStream = {
      id: "cam-stream-1",
      getTracks: () => [camTrack],
      getVideoTracks: () => [camTrack],
    } as unknown as MediaStream;
    const camTrack = makeTrack("cam", camStop);

    const scrStream = {
      id: "scr-stream-1",
      getTracks: () => [scrTrack],
      getVideoTracks: () => [scrTrack],
    } as unknown as MediaStream;
    const scrTrack = makeTrack("screen", screenStop, "monitor");

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(camStream),
        getDisplayMedia: vi.fn().mockResolvedValue(scrStream),
      },
    });

    const camInterrupts = vi.fn();
    const scrInterrupts = vi.fn();
    let api!: ReturnType<typeof useProctoringMedia>;

    function MediaHarness({ active }: { active: boolean }) {
      api = useProctoringMedia({
        enabled: active,
        onCameraInterrupted: camInterrupts,
        onScreenShareInterrupted: scrInterrupts,
      });
      return <span>{api.state.cameraActive ? "cam-on" : "cam-off"}</span>;
    }

    const { rerender } = render(<MediaHarness active />);

    await act(async () => {
      const cRes = await api.requestCamera();
      expect(cRes.ok).toBe(true);
      const sRes = await api.requestScreenShare(ScreenSurfacePolicy.MONITOR);
      expect(sRes.ok).toBe(true);
    });

    expect(screen.getByText("cam-on")).toBeInTheDocument();

    // Repeated ended events on the same camera stream fire at most once
    act(() => {
      for (const fn of listeners.cam!) fn();
      for (const fn of listeners.cam!) fn();
    });
    expect(camInterrupts).toHaveBeenCalledTimes(1);

    // Disabling hook stops remaining live tracks automatically
    rerender(<MediaHarness active={false} />);
    await waitFor(() => {
      expect(camStop).toHaveBeenCalled();
      expect(screenStop).toHaveBeenCalled();
    });
  });

  it("rejects mismatched displaySurface when MONITOR policy is required and immediately stops tracks", async () => {
    const tabTrackStop = vi.fn();
    const tabStream = {
      id: "tab-stream-1",
      getTracks: () => [tabTrack],
      getVideoTracks: () => [tabTrack],
    } as unknown as MediaStream;
    const tabTrack = {
      kind: "video",
      readyState: "live",
      stop: tabTrackStop,
      getSettings: () => ({ displaySurface: "browser" }),
      addEventListener: vi.fn(),
    };

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
        getDisplayMedia: vi.fn().mockResolvedValue(tabStream),
      },
    });

    let api!: ReturnType<typeof useProctoringMedia>;
    function MediaSurfaceHarness() {
      api = useProctoringMedia({ enabled: true });
      return null;
    }
    render(<MediaSurfaceHarness />);

    await act(async () => {
      const res = await api.requestScreenShare(ScreenSurfacePolicy.MONITOR);
      expect(res.ok).toBe(false);
      expect(res.displaySurface).toBe("browser");
      expect(res.error).toContain("monitor");
    });

    expect(tabTrackStop).toHaveBeenCalled();
  });
});
