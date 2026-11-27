// Ephemeral in-memory handoff container for active MediaStreams between
// StudentExamPreflightPage and StudentExamTakingPage within the same SPA session.
// Never persists anything to localStorage, sessionStorage, IndexedDB, or cookies.

interface HandoffEntry {
  attemptId: string;
  cameraStream: MediaStream | null;
  screenStream: MediaStream | null;
  displaySurface: "monitor" | "window" | "browser" | "unknown";
  createdAt: number;
}

let pendingHandoff: HandoffEntry | null = null;

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

export function setPendingProctoringStreams(entry: Omit<HandoffEntry, "createdAt">): void {
  if (pendingHandoff) {
    if (pendingHandoff.cameraStream && pendingHandoff.cameraStream !== entry.cameraStream) {
      stopStream(pendingHandoff.cameraStream);
    }
    if (pendingHandoff.screenStream && pendingHandoff.screenStream !== entry.screenStream) {
      stopStream(pendingHandoff.screenStream);
    }
  }
  pendingHandoff = {
    ...entry,
    createdAt: Date.now(),
  };
}

export function consumePendingProctoringStreams(attemptId: string): Omit<HandoffEntry, "attemptId" | "createdAt"> | null {
  if (!pendingHandoff) return null;
  if (pendingHandoff.attemptId !== attemptId || Date.now() - pendingHandoff.createdAt > 120_000) {
    stopStream(pendingHandoff.cameraStream);
    stopStream(pendingHandoff.screenStream);
    pendingHandoff = null;
    return null;
  }

  const result = {
    cameraStream: pendingHandoff.cameraStream,
    screenStream: pendingHandoff.screenStream,
    displaySurface: pendingHandoff.displaySurface,
  };
  pendingHandoff = null;
  return result;
}

export function clearPendingProctoringStreams(): void {
  if (!pendingHandoff) return;
  stopStream(pendingHandoff.cameraStream);
  stopStream(pendingHandoff.screenStream);
  pendingHandoff = null;
}
