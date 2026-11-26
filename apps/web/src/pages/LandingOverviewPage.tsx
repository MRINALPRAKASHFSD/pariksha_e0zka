import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Activity, Database, Lock, LogIn, RefreshCw, ShieldAlert } from "lucide-react";
import {
  BROWSER_SECURITY_LIMITATIONS,
  DEFAULT_PROCTORING_POLICY,
  type ApiSuccessResponse,
  type HealthCheckStatus,
} from "@pariksha/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/context/toast-context";
import { getHomeRouteForRole, useAuth } from "@/context/auth-context";

export function LandingOverviewPage() {
  const { pushToast } = useToast();
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const [health, setHealth] = useState<HealthCheckStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/health", { credentials: "include" });
      if (!response.ok) {
        throw new Error(`Health endpoint returned HTTP ${response.status}`);
      }
      const json = (await response.json()) as ApiSuccessResponse<HealthCheckStatus>;
      setHealth(json.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reach API server";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHealth();
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="mx-auto max-w-6xl space-y-6"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pariksha Platform Foundation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live system telemetry, security posture, and institutional proctoring policy defaults.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void loadHealth();
              pushToast({ title: "Refreshing health check", description: "Querying /api/v1/health" });
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh Status
          </Button>
          {status === "authenticated" && user ? (
            <Button size="sm" onClick={() => navigate(getHomeRouteForRole(user.role))}>
              Open {user.role} Portal
            </Button>
          ) : (
            <Button size="sm" onClick={() => navigate("/login")}>
              <LogIn className="h-4 w-4" />
              Sign In
            </Button>
          )}
        </div>
      </div>

      {/* Live System Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Service</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-28" />
            ) : error ? (
              <Badge variant="destructive">Offline</Badge>
            ) : (
              <div className="flex items-center gap-2">
                <Badge variant={health?.status === "ok" ? "success" : "warning"}>
                  {health?.status === "ok" ? "Operational" : "Degraded"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Uptime: {health?.uptimeSeconds ?? 0}s
                </span>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              {error ? error : `Service: ${health?.service ?? "pariksha-api"}`}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">PostgreSQL Database</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-7 w-32" />
            ) : (
              <div className="flex items-center gap-2">
                <Badge variant={health?.database.connected ? "success" : "destructive"}>
                  {health?.database.connected ? "Connected" : "Disconnected"}
                </Badge>
                {health?.database.latencyMs !== null && health?.database.latencyMs !== undefined && (
                  <span className="text-xs font-mono text-muted-foreground">
                    {health.database.latencyMs} ms
                  </span>
                )}
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Database-verified via live Prisma SELECT 1 probe.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Client Storage Hygiene</CardTitle>
            <Lock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <Badge variant="default">In-Memory + HttpOnly Cookies</Badge>
            <p className="mt-2 text-xs text-muted-foreground">
              Zero exam answers, violations, errors, or tokens in localStorage or sessionStorage.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Default Proctoring Policy Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Institutional Default Proctoring Controls</CardTitle>
          <CardDescription>
            Shared contract from @pariksha/shared; configurable exclusively by Administrators in
            Phase 5.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Violation Threshold</p>
              <p className="mt-1 text-lg font-semibold">
                {DEFAULT_PROCTORING_POLICY.violationThreshold} Strikes
              </p>
              <p className="text-xs text-muted-foreground">1st warning, 2nd auto-submit</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Media Requirements</p>
              <p className="mt-1 text-sm font-medium">Webcam &amp; Screen Share</p>
              <p className="text-xs text-muted-foreground">Pause attempt on media loss</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Dedup Window</p>
              <p className="mt-1 text-lg font-semibold">
                {DEFAULT_PROCTORING_POLICY.dedupWindowSeconds}s
              </p>
              <p className="text-xs text-muted-foreground">Merges paired blur/visibility events</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Heartbeat Interval</p>
              <p className="mt-1 text-lg font-semibold">
                {DEFAULT_PROCTORING_POLICY.heartbeatIntervalSeconds}s
              </p>
              <p className="text-xs text-muted-foreground">
                Timeout at {DEFAULT_PROCTORING_POLICY.heartbeatTimeoutSeconds}s
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Browser Security Limitations Notice */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <CardTitle>Documented Browser Security Limitations</CardTitle>
          </div>
          <CardDescription>
            Transparent disclosure of browser capabilities and heuristic-only observations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
            {BROWSER_SECURITY_LIMITATIONS.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </motion.div>
  );
}
