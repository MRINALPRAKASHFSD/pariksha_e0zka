import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import {
  Download,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import {
  ExtensionStrikeMode,
  IntegrityEventType,
  IntegritySeverity,
  ScreenSurfacePolicy,
  type AdminProctoringAttemptItemDto,
  type ExamProctoringPolicyStateDto,
  type ExamSummaryDto,
  type IntegrityEventDto,
  type PaginatedResult,
  type ProctoringPolicyConfig,
  type ProctoringPolicyRecordDto,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { formatDateTimeShort, getAttemptStatusBadgeVariant } from "@/lib/examUi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type ProctoringAdminTab = "policies" | "attempts" | "events";

interface PoliciesOverviewDto {
  defaultPolicy: ProctoringPolicyRecordDto;
  examPolicies: Array<ProctoringPolicyRecordDto & { exam?: { id: string; title: string; status: string } | null }>;
}

interface AttemptsMonitorResponse extends PaginatedResult<AdminProctoringAttemptItemDto> {
  mediaStatusDisclaimer: string;
}

export function AdminProctoringPage() {
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialTab = (searchParams.get("tab") as ProctoringAdminTab) || "policies";
  const [tab, setTab] = useState<ProctoringAdminTab>(initialTab);

  const [loading, setLoading] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [defaultPolicy, setDefaultPolicy] = useState<ProctoringPolicyRecordDto | null>(null);
  const [examsList, setExamsList] = useState<ExamSummaryDto[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>(searchParams.get("examId") ?? "__DEFAULT__");
  const [examPolicyState, setExamPolicyState] = useState<ExamProctoringPolicyStateDto | null>(null);
  const [draftPolicy, setDraftPolicy] = useState<ProctoringPolicyConfig | null>(null);
  const [overrideActive, setOverrideActive] = useState<boolean>(true);

  const [attemptsData, setAttemptsData] = useState<AttemptsMonitorResponse | null>(null);
  const [attemptSearch, setAttemptSearch] = useState("");
  const [attemptStatusFilter, setAttemptStatusFilter] = useState("");

  const [eventsData, setEventsData] = useState<PaginatedResult<IntegrityEventDto> | null>(null);
  const [eventSearch, setEventSearch] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");

  const loadPoliciesAndExams = useCallback(async () => {
    const [policiesRes, examsRes] = await Promise.all([
      apiRequest<PoliciesOverviewDto>("/admin/proctoring/policies"),
      apiRequest<PaginatedResult<ExamSummaryDto>>("/admin/exams?page=1&pageSize=100"),
    ]);
    setDefaultPolicy(policiesRes.defaultPolicy);
    setExamsList(examsRes.items);

    if (selectedExamId === "__DEFAULT__") {
      setExamPolicyState(null);
      setDraftPolicy({ ...policiesRes.defaultPolicy });
    } else {
      const state = await apiRequest<ExamProctoringPolicyStateDto>(
        `/admin/proctoring/exams/${selectedExamId}/policy`,
      );
      setExamPolicyState(state);
      setDraftPolicy(
        state.examOverride ? { ...state.examOverride } : { ...state.effectivePolicy },
      );
      setOverrideActive(state.examOverride ? state.examOverride.isActive : true);
    }
  }, [selectedExamId]);

  const loadAttempts = useCallback(async () => {
    const params = new URLSearchParams({ page: "1", pageSize: "30" });
    if (attemptSearch.trim()) params.set("search", attemptSearch.trim());
    if (attemptStatusFilter) params.set("status", attemptStatusFilter);
    const res = await apiRequest<AttemptsMonitorResponse>(
      `/admin/proctoring/attempts?${params.toString()}`,
    );
    setAttemptsData(res);
  }, [attemptSearch, attemptStatusFilter]);

  const loadEvents = useCallback(async () => {
    const params = new URLSearchParams({ page: "1", pageSize: "40" });
    if (eventSearch.trim()) params.set("search", eventSearch.trim());
    if (eventTypeFilter) params.set("eventType", eventTypeFilter);
    if (severityFilter) params.set("severity", severityFilter);
    const res = await apiRequest<PaginatedResult<IntegrityEventDto>>(
      `/admin/proctoring/events?${params.toString()}`,
    );
    setEventsData(res);
  }, [eventSearch, eventTypeFilter, severityFilter]);

  const loadAll = useCallback(async (showSkeleton = false) => {
    if (showSkeleton) setLoading(true);
    try {
      await Promise.all([loadPoliciesAndExams(), loadAttempts(), loadEvents()]);
    } catch (err) {
      pushToast({
        title: "Failed to load proctoring console",
        description: err instanceof ApiClientError ? err.message : "Try refreshing.",
      });
    } finally {
      if (showSkeleton) setLoading(false);
    }
  }, [loadPoliciesAndExams, loadAttempts, loadEvents, pushToast]);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  useEffect(() => {
    const socket = io({
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
    socket.emit("proctoring:join-admin-monitor");

    const refreshLive = () => {
      void loadAttempts();
      void loadEvents();
    };
    socket.on("proctoring:event", refreshLive);
    socket.on("exam:attempt-finalized", refreshLive);

    return () => {
      socket.disconnect();
    };
  }, [loadAttempts, loadEvents]);

  const selectTab = (next: ProctoringAdminTab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  const handleSelectScope = async (scopeId: string) => {
    setSelectedExamId(scopeId);
    try {
      if (scopeId === "__DEFAULT__") {
        setExamPolicyState(null);
        if (defaultPolicy) setDraftPolicy({ ...defaultPolicy });
      } else {
        const state = await apiRequest<ExamProctoringPolicyStateDto>(
          `/admin/proctoring/exams/${scopeId}/policy`,
        );
        setExamPolicyState(state);
        setDraftPolicy(
          state.examOverride ? { ...state.examOverride } : { ...state.effectivePolicy },
        );
        setOverrideActive(state.examOverride ? state.examOverride.isActive : true);
      }
    } catch (err) {
      pushToast({
        title: "Unable to load policy scope",
        description: err instanceof ApiClientError ? err.message : "Try again.",
      });
    }
  };

  const handleSavePolicy = async () => {
    if (!draftPolicy) return;
    setSavingPolicy(true);
    try {
      if (selectedExamId === "__DEFAULT__") {
        const updated = await apiRequest<ProctoringPolicyRecordDto>(
          "/admin/proctoring/default-policy",
          {
            method: "PATCH",
            body: JSON.stringify(draftPolicy),
          },
        );
        setDefaultPolicy(updated);
        setDraftPolicy({ ...updated });
        pushToast({
          title: "Institutional default policy updated",
          description: `Saved Policy v${updated.version}.`,
        });
      } else {
        const updated = await apiRequest<ExamProctoringPolicyStateDto>(
          `/admin/proctoring/exams/${selectedExamId}/policy`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...draftPolicy,
              isActive: overrideActive,
            }),
          },
        );
        setExamPolicyState(updated);
        pushToast({
          title: "Exam proctoring policy saved",
          description: `Effective version v${updated.effectivePolicyVersion}.`,
        });
      }
    } catch (err) {
      pushToast({
        title: "Policy update failed",
        description: err instanceof ApiClientError ? err.message : "Verify numeric bounds.",
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRestoreOrReset = async () => {
    setSavingPolicy(true);
    try {
      if (selectedExamId === "__DEFAULT__") {
        const restored = await apiRequest<ProctoringPolicyRecordDto>(
          "/admin/proctoring/default-policy/restore",
          { method: "POST" },
        );
        setDefaultPolicy(restored);
        setDraftPolicy({ ...restored });
        pushToast({ title: "Institutional defaults restored", description: `Policy v${restored.version}` });
      } else {
        const reset = await apiRequest<ExamProctoringPolicyStateDto>(
          `/admin/proctoring/exams/${selectedExamId}/policy/reset`,
          { method: "POST" },
        );
        setExamPolicyState(reset);
        setDraftPolicy({ ...reset.effectivePolicy });
        setOverrideActive(true);
        pushToast({ title: "Exam policy reset to institutional defaults" });
      }
    } catch (err) {
      pushToast({
        title: "Reset failed",
        description: err instanceof ApiClientError ? err.message : "Could not reset policy.",
      });
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleTerminateAttempt = async (examId: string, attemptId: string) => {
    try {
      await apiRequest(`/admin/exams/${examId}/attempts/${attemptId}/terminate`, {
        method: "POST",
        body: JSON.stringify({ reason: "Terminated by administrator from Proctoring Monitor" }),
      });
      pushToast({ title: "Attempt terminated", description: "Attempt locked and finalized." });
      await loadAttempts();
      await loadEvents();
    } catch (err) {
      pushToast({
        title: "Terminate failed",
        description: err instanceof ApiClientError ? err.message : "Could not terminate attempt.",
      });
    }
  };

  const toggleBool = (field: keyof ProctoringPolicyConfig) => {
    setDraftPolicy((prev) =>
      prev ? { ...prev, [field]: !(prev[field] as boolean) } : prev,
    );
  };

  const setNum = (field: keyof ProctoringPolicyConfig, value: string) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      setDraftPolicy((prev) => (prev ? { ...prev, [field]: parsed } : prev));
    }
  };

  const exportCsvUrl = (() => {
    const params = new URLSearchParams();
    if (eventSearch.trim()) params.set("search", eventSearch.trim());
    if (eventTypeFilter) params.set("eventType", eventTypeFilter);
    if (severityFilter) params.set("severity", severityFilter);
    const q = params.toString();
    return `/api/v1/admin/proctoring/events/export${q ? `?${q}` : ""}`;
  })();

  if (loading || !draftPolicy) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Proctoring &amp; Integrity Control Center</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure institutional policies, monitor active examination sessions, review integrity timelines, and enforce strike rules.
          </p>
        </div>

        <Button variant="outline" size="sm" onClick={() => void loadAll(false)}>
          <RefreshCw className="h-4 w-4" />
          Refresh Telemetry
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 border-b pb-3">
        {(
          [
            ["policies", "Policy Rules"],
            ["attempts", `Live & Recent Attempts (${attemptsData?.total ?? 0})`],
            ["events", `Integrity Timeline (${eventsData?.total ?? 0})`],
          ] as Array<[ProctoringAdminTab, string]>
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? "default" : "outline"}
            onClick={() => selectTab(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {tab === "policies" && (
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Sliders className="h-5 w-5 text-primary" />
                  {selectedExamId === "__DEFAULT__"
                    ? `Institutional Default Policy (v${defaultPolicy?.version ?? 1})`
                    : `${examPolicyState?.examTitle ?? "Exam Policy Override"} (${examPolicyState?.inheritedFromDefault ? "Inheriting Default" : `Override v${examPolicyState?.effectivePolicyVersion ?? 1}`})`}
                </CardTitle>
                <CardDescription>
                  Policies are snapshotted onto each student attempt at start so active examinees experience deterministic enforcement.
                </CardDescription>
              </div>

              <div className="min-w-64">
                <Label htmlFor="policy-scope-select" className="sr-only">
                  Policy Scope
                </Label>
                <select
                  id="policy-scope-select"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={selectedExamId}
                  onChange={(e) => void handleSelectScope(e.target.value)}
                >
                  <option value="__DEFAULT__">Institutional Default Policy</option>
                  {examsList.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.courseCode} — {ex.title} ({ex.status})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedExamId !== "__DEFAULT__" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={overrideActive}
                  onChange={(e) => setOverrideActive(e.target.checked)}
                />
                <span>
                  Enable custom exam override (uncheck to fall back to institutional default while retaining saved fields)
                </span>
              </label>
            )}
          </CardHeader>

          <CardContent className="space-y-6">
            <div className="grid gap-6 md:grid-cols-3">
              {/* Media & Fullscreen */}
              <div className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">1. Hardware &amp; Fullscreen</h3>
                {(
                  [
                    ["requireWebcam", "Require Webcam Permission"],
                    ["requireScreenShare", "Require Screen Sharing"],
                    ["requireFullscreen", "Require Fullscreen Mode"],
                    ["pauseOnMediaLoss", "Pause Attempt on Media Loss"],
                    ["detectCameraInterruption", "Detect Camera Interruption"],
                    ["detectScreenShareInterruption", "Detect Screen Share Interruption"],
                  ] as Array<[keyof ProctoringPolicyConfig, string]>
                ).map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(draftPolicy[field])}
                      onChange={() => toggleBool(field)}
                    />
                    <span>{label}</span>
                  </label>
                ))}

                <div className="space-y-1 pt-1">
                  <Label htmlFor="screen-surface-select" className="text-xs">
                    Allowed Screen Share Surface
                  </Label>
                  <select
                    id="screen-surface-select"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
                    value={draftPolicy.allowedScreenSurface}
                    onChange={(e) =>
                      setDraftPolicy((p) =>
                        p ? { ...p, allowedScreenSurface: e.target.value as ScreenSurfacePolicy } : p,
                      )
                    }
                  >
                    <option value={ScreenSurfacePolicy.ANY}>Any Surface (Screen/Window/Tab)</option>
                    <option value={ScreenSurfacePolicy.MONITOR}>Entire Monitor Preferred</option>
                    <option value={ScreenSurfacePolicy.WINDOW}>Application Window</option>
                    <option value={ScreenSurfacePolicy.BROWSER}>Browser Tab</option>
                  </select>
                </div>
              </div>

              {/* Lockdown & Heuristics */}
              <div className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">2. Lockdown &amp; Heuristics</h3>
                {(
                  [
                    ["detectTabSwitch", "Detect Tab Switch (visibilitychange)"],
                    ["detectWindowBlur", "Detect Window Focus Loss (blur)"],
                    ["detectFullscreenExit", "Detect Fullscreen Exit"],
                    ["restrictCopyPasteCut", "Block Copy / Paste / Cut"],
                    ["restrictSelectAll", "Block Select-All Shortcut"],
                    ["restrictRightClick", "Block Context Menu (Right-Click)"],
                    ["restrictTextSelection", "Restrict Prompt Text Selection"],
                    ["detectClipboard", "Log Clipboard Telemetry"],
                    ["detectExtensionsHeuristic", "Best-Effort Extension DOM Heuristics"],
                  ] as Array<[keyof ProctoringPolicyConfig, string]>
                ).map(([field, label]) => (
                  <label key={field} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(draftPolicy[field])}
                      onChange={() => toggleBool(field)}
                    />
                    <span>{label}</span>
                  </label>
                ))}

                <div className="space-y-1 pt-1">
                  <Label htmlFor="extension-mode-select" className="text-xs">
                    Extension Heuristic Impact
                  </Label>
                  <select
                    id="extension-mode-select"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
                    value={draftPolicy.extensionStrikeMode}
                    onChange={(e) =>
                      setDraftPolicy((p) =>
                        p ? { ...p, extensionStrikeMode: e.target.value as ExtensionStrikeMode } : p,
                      )
                    }
                  >
                    <option value={ExtensionStrikeMode.AUDIT_ONLY}>
                      Audit / Flag Only (Recommended)
                    </option>
                    <option value={ExtensionStrikeMode.STRIKE}>Count Toward Strikes</option>
                  </select>
                </div>
              </div>

              {/* Strikes & Heartbeats */}
              <div className="space-y-3 rounded-lg border p-4">
                <h3 className="text-sm font-semibold">3. Thresholds &amp; Heartbeats</h3>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draftPolicy.monitorConnectionHeartbeat}
                    onChange={() => toggleBool("monitorConnectionHeartbeat")}
                  />
                  <span>Monitor Server Connection Heartbeat</span>
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draftPolicy.monitorMediaHeartbeat}
                    onChange={() => toggleBool("monitorMediaHeartbeat")}
                  />
                  <span>Monitor Media Health Flags</span>
                </label>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <Label htmlFor="threshold-input" className="text-xs">
                      Strike Threshold
                    </Label>
                    <Input
                      id="threshold-input"
                      type="number"
                      min={1}
                      max={10}
                      value={draftPolicy.violationThreshold}
                      onChange={(e) => setNum("violationThreshold", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="dedup-input" className="text-xs">
                      Dedup Window (sec)
                    </Label>
                    <Input
                      id="dedup-input"
                      type="number"
                      min={0}
                      max={120}
                      value={draftPolicy.dedupWindowSeconds}
                      onChange={(e) => setNum("dedupWindowSeconds", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="hb-int-input" className="text-xs">
                      Heartbeat Interval (s)
                    </Label>
                    <Input
                      id="hb-int-input"
                      type="number"
                      min={5}
                      max={120}
                      value={draftPolicy.heartbeatIntervalSeconds}
                      onChange={(e) => setNum("heartbeatIntervalSeconds", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="hb-timeout-input" className="text-xs">
                      Heartbeat Timeout (s)
                    </Label>
                    <Input
                      id="hb-timeout-input"
                      type="number"
                      min={15}
                      max={600}
                      value={draftPolicy.heartbeatTimeoutSeconds}
                      onChange={(e) => setNum("heartbeatTimeoutSeconds", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="hb-grace-input" className="text-xs">
                      Heartbeat Grace (s)
                    </Label>
                    <Input
                      id="hb-grace-input"
                      type="number"
                      min={0}
                      max={300}
                      value={draftPolicy.heartbeatGraceSeconds}
                      onChange={(e) => setNum("heartbeatGraceSeconds", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="media-grace-input" className="text-xs">
                      Media Grace (s)
                    </Label>
                    <Input
                      id="media-grace-input"
                      type="number"
                      min={0}
                      max={300}
                      value={draftPolicy.mediaGraceSeconds}
                      onChange={(e) => setNum("mediaGraceSeconds", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={savingPolicy}
                onClick={() => void handleRestoreOrReset()}
              >
                <RotateCcw className="h-4 w-4" />
                {selectedExamId === "__DEFAULT__"
                  ? "Restore Institutional Defaults"
                  : "Reset Exam to Default"}
              </Button>
              <Button
                type="button"
                disabled={savingPolicy}
                onClick={() => void handleSavePolicy()}
              >
                <Save className="h-4 w-4" />
                {savingPolicy
                  ? "Saving Policy..."
                  : selectedExamId === "__DEFAULT__"
                    ? "Save Institutional Default Policy"
                    : "Save Exam Policy Override"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === "attempts" && (
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  Attempt Integrity &amp; Connectivity Monitor
                </CardTitle>
                <CardDescription>
                  {attemptsData?.mediaStatusDisclaimer}
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="Search student or exam..."
                  className="w-52"
                  value={attemptSearch}
                  onChange={(e) => setAttemptSearch(e.target.value)}
                />
                <select
                  aria-label="Filter attempt status"
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                  value={attemptStatusFilter}
                  onChange={(e) => setAttemptStatusFilter(e.target.value)}
                >
                  <option value="">All Statuses</option>
                  <option value="IN_PROGRESS">IN_PROGRESS</option>
                  <option value="PAUSED">PAUSED</option>
                  <option value="AUTO_SUBMITTED">AUTO_SUBMITTED</option>
                  <option value="SUBMITTED">SUBMITTED</option>
                  <option value="EXPIRED">EXPIRED</option>
                  <option value="TERMINATED">TERMINATED</option>
                </select>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!attemptsData || attemptsData.items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No examination attempts matching the current filter.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Candidate</th>
                      <th className="py-2 pr-3">Examination</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Strikes</th>
                      <th className="py-2 pr-3">Client-Reported Media</th>
                      <th className="py-2 pr-3">Last Heartbeat</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attemptsData.items.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="py-2.5 pr-3">
                          <div className="font-medium">{item.student.fullName}</div>
                          <div className="text-xs text-muted-foreground">{item.student.email}</div>
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium">{item.examTitle}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.courseCode} · Policy v{item.policyVersion}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 space-y-1">
                          <Badge variant={getAttemptStatusBadgeVariant(item.status)}>
                            {item.status}
                          </Badge>
                          {item.pauseReason && (
                            <div className="text-xs text-amber-700 dark:text-amber-300">
                              {item.pauseReason}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs">
                          {item.violationCount} / {item.strikeThreshold}
                          <div className="text-muted-foreground">{item.warningCount} warnings</div>
                        </td>
                        <td className="py-2.5 pr-3 text-xs">
                          <div>Cam: {item.cameraActive ? "Active" : "Inactive"}</div>
                          <div>Screen: {item.screenShareActive ? "Active" : "Inactive"}</div>
                          <div>FS: {item.fullscreenActive ? "Active" : "No"}</div>
                        </td>
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          {formatDateTimeShort(item.lastHeartbeatAt)}
                        </td>
                        <td className="py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEventSearch(item.student.email);
                                selectTab("events");
                              }}
                            >
                              Events
                            </Button>
                            {(item.status === "IN_PROGRESS" || item.status === "PAUSED") && (
                              <Button
                                size="sm"
                                variant="destructive"
                                onClick={() =>
                                  void handleTerminateAttempt(item.examId, item.id)
                                }
                              >
                                Terminate
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "events" && (
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5 text-amber-600" />
                  Integrity Event Timeline
                </CardTitle>
                <CardDescription>
                  Deduplicated immutable log of client-reported, heuristic, and server-detected integrity telemetry.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input
                  placeholder="Search student, description..."
                  className="w-48"
                  value={eventSearch}
                  onChange={(e) => setEventSearch(e.target.value)}
                />
                <select
                  aria-label="Filter event type"
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                  value={eventTypeFilter}
                  onChange={(e) => setEventTypeFilter(e.target.value)}
                >
                  <option value="">All Event Types</option>
                  {Object.values(IntegrityEventType).map((et) => (
                    <option key={et} value={et}>
                      {et}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter severity"
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                >
                  <option value="">All Severities</option>
                  {Object.values(IntegritySeverity).map((sev) => (
                    <option key={sev} value={sev}>
                      {sev}
                    </option>
                  ))}
                </select>
                <Button asChild variant="outline" size="sm">
                  <a href={exportCsvUrl} download="integrity-events.csv">
                    <Download className="h-4 w-4" />
                    Export CSV
                  </a>
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {!eventsData || eventsData.items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No integrity events recorded for these filters.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b text-xs text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3">Occurred</th>
                      <th className="py-2 pr-3">Student &amp; Exam</th>
                      <th className="py-2 pr-3">Event Type</th>
                      <th className="py-2 pr-3">Signal</th>
                      <th className="py-2 pr-3">Strike Result</th>
                      <th className="py-2">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {eventsData.items.map((ev) => (
                      <tr key={ev.id} className="border-b last:border-0">
                        <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                          {formatDateTimeShort(ev.occurredAt)}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium">{ev.studentName ?? "Candidate"}</div>
                          <div className="text-xs text-muted-foreground">
                            {ev.courseCode} · {ev.examTitle}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 space-y-1">
                          <Badge variant={ev.severity === "CRITICAL" ? "destructive" : "outline"}>
                            {ev.eventType}
                          </Badge>
                          <div className="text-xs text-muted-foreground">{ev.severity}</div>
                        </td>
                        <td className="py-2.5 pr-3 text-xs">
                          <div>{ev.confidence}</div>
                          {ev.deduplicatedIntoId && (
                            <Badge variant="outline" className="mt-1">
                              Deduplicated
                            </Badge>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-xs">
                          {ev.countedAsStrike ? (
                            <span className="text-destructive font-semibold">
                              Strike #{ev.violationNumberAfter}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Audit / Non-Strike</span>
                          )}
                        </td>
                        <td className="py-2.5 text-xs text-muted-foreground max-w-md">
                          {ev.description}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
