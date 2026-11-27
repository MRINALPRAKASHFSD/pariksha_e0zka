import { useEffect, useState } from "react";
import type { AuditLogDto, PaginatedResult } from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminAuditLogsPage() {
  const [logs, setLogs] = useState<PaginatedResult<AuditLogDto> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest<PaginatedResult<AuditLogDto>>(
          `/admin/audit-logs?page=${page}&pageSize=15`,
        );
        if (active) setLogs(res);
      } catch (err) {
        if (active) {
          setError(err instanceof ApiClientError ? err.message : "Failed to load audit logs.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [page]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Security &amp; Audit Logs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Immutable log of authentication events and privileged administrative actions.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Events</CardTitle>
          <CardDescription>
            {logs ? `${logs.total} recorded event(s)` : "Loading audit history..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Timestamp</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Actor Role</th>
                  <th className="px-4 py-3 font-medium">Entity</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-4 py-3" colSpan={4}>
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : logs && logs.items.length > 0 ? (
                  logs.items.map((log) => (
                    <tr key={log.id}>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-medium">{log.action}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{log.actorRole ?? "SYSTEM"}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {log.entityType}
                        {log.entityId ? ` (${log.entityId.slice(0, 8)}...)` : ""}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={4}>
                      No audit events recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {logs && logs.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
              <span>
                Page {logs.page} of {logs.totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= logs.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
