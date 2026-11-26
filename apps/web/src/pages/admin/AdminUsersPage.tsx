import React, { useCallback, useEffect, useState } from "react";
import {
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldBan,
  ShieldCheck,
  UserX,
} from "lucide-react";
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
  type AdminUserListItemDto,
  type AdminUsersListResponse,
  type UserRole,
  type UserStatus,
} from "@pariksha/shared";
import { ApiClientError, apiRequest } from "@/lib/api";
import { useToast } from "@/context/toast-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function AdminUsersPage() {
  const { pushToast } = useToast();

  const [usersData, setUsersData] = useState<AdminUsersListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "ALL">("ALL");
  const [statusFilter, setStatusFilter] = useState<UserStatus | "ALL">("ALL");
  const [page, setPage] = useState(1);

  // Create Dialog State
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<"TEACHER" | "STUDENT">("STUDENT");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Edit Dialog State
  const [editTarget, setEditTarget] = useState<AdminUserListItemDto | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState<"TEACHER" | "STUDENT">("STUDENT");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Reset Password Dialog State
  const [resetTarget, setResetTarget] = useState<AdminUserListItemDto | null>(null);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: "10",
      });
      if (search.trim()) params.set("search", search.trim());
      if (roleFilter !== "ALL") params.set("role", roleFilter);
      if (statusFilter !== "ALL") params.set("status", statusFilter);

      const res = await apiRequest<AdminUsersListResponse>(`/admin/users?${params.toString()}`);
      setUsersData(res);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, [page, search, roleFilter, statusFilter]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const handleCreateUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreateError(null);

    const parsed = adminCreateUserSchema.safeParse({
      fullName: createName,
      email: createEmail,
      password: createPassword,
      role: createRole,
      status: "ACTIVE",
    });
    if (!parsed.success) {
      setCreateError(parsed.error.issues[0]?.message ?? "Invalid user details.");
      return;
    }

    setCreating(true);
    try {
      await apiRequest<AdminUserListItemDto>("/admin/users", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      pushToast({
        title: "Account created",
        description: `${parsed.data.role} account created for ${parsed.data.email}`,
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateEmail("");
      setCreatePassword("");
      setCreateRole("STUDENT");
      await fetchUsers();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : "Failed to create account.");
    } finally {
      setCreating(false);
    }
  };

  const openEditDialog = (target: AdminUserListItemDto) => {
    setEditTarget(target);
    setEditName(target.fullName);
    setEditEmail(target.email);
    setEditRole(target.role === "TEACHER" ? "TEACHER" : "STUDENT");
    setEditError(null);
  };

  const handleEditUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editTarget) return;
    setEditError(null);

    const payload =
      editTarget.role === "ADMIN"
        ? { fullName: editName, email: editEmail }
        : { fullName: editName, email: editEmail, role: editRole };

    const parsed = adminUpdateUserSchema.safeParse(payload);
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? "Invalid update values.");
      return;
    }

    setSavingEdit(true);
    try {
      await apiRequest<AdminUserListItemDto>(`/admin/users/${editTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      pushToast({ title: "User updated", description: editEmail });
      setEditTarget(null);
      await fetchUsers();
    } catch (err) {
      setEditError(err instanceof ApiClientError ? err.message : "Failed to update user.");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleStatus = async (target: AdminUserListItemDto) => {
    const nextStatus: UserStatus = target.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    try {
      await apiRequest<AdminUserListItemDto>(`/admin/users/${target.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      pushToast({
        title: nextStatus === "ACTIVE" ? "Account activated" : "Account deactivated",
        description: `${target.email} is now ${nextStatus}`,
      });
      await fetchUsers();
    } catch (err) {
      pushToast({
        title: "Status update blocked",
        description: err instanceof ApiClientError ? err.message : "Could not update status.",
      });
    }
  };

  const handleRevokeSessions = async (target: AdminUserListItemDto) => {
    try {
      const res = await apiRequest<{ userId: string; revokedCount: number }>(
        `/admin/users/${target.id}/revoke-sessions`,
        { method: "POST" },
      );
      pushToast({
        title: "Sessions revoked",
        description: `Revoked ${res.revokedCount} active session(s) for ${target.email}.`,
      });
      await fetchUsers();
    } catch (err) {
      pushToast({
        title: "Revocation failed",
        description: err instanceof ApiClientError ? err.message : "Unable to revoke sessions.",
      });
    }
  };

  const handleGenerateTemporaryPassword = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      const res = await apiRequest<{
        userId: string;
        sessionsRevoked: number;
        temporaryPassword: string | null;
      }>(`/admin/users/${resetTarget.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setGeneratedPassword(res.temporaryPassword);
      pushToast({
        title: "Temporary password issued",
        description: `Revoked ${res.sessionsRevoked} active session(s).`,
      });
      await fetchUsers();
    } catch (err) {
      pushToast({
        title: "Password reset failed",
        description: err instanceof ApiClientError ? err.message : "Unable to reset password.",
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User Management</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create teacher and student accounts, filter directory, manage status, and revoke
            sessions.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Create Account
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Directory Filters</CardTitle>
          <CardDescription>
            {usersData
              ? `Showing ${usersData.items.length} of ${usersData.total} matching account(s) (${usersData.summary.total} total)`
              : "Search by name or email and filter by role or status."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label="Search users"
              placeholder="Search name or email..."
              className="pl-8"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <select
            aria-label="Filter by role"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={roleFilter}
            onChange={(e) => {
              setRoleFilter(e.target.value as UserRole | "ALL");
              setPage(1);
            }}
          >
            <option value="ALL">All Roles</option>
            <option value="ADMIN">Admin</option>
            <option value="TEACHER">Teacher</option>
            <option value="STUDENT">Student</option>
          </select>

          <select
            aria-label="Filter by status"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as UserStatus | "ALL");
              setPage(1);
            }}
          >
            <option value="ALL">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
        </CardContent>
      </Card>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* User Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Sessions</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {loading ? (
                  Array.from({ length: 4 }).map((_, idx) => (
                    <tr key={idx}>
                      <td className="px-4 py-3" colSpan={5}>
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))
                ) : usersData && usersData.items.length > 0 ? (
                  usersData.items.map((item) => (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <p className="font-medium text-foreground">{item.fullName}</p>
                        <p className="text-xs text-muted-foreground">{item.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="default">{item.role}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            item.status === "ACTIVE"
                              ? "success"
                              : item.status === "INACTIVE"
                                ? "warning"
                                : "destructive"
                          }
                        >
                          {item.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{item.activeSessionCount}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditDialog(item)}
                            title="Edit user"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleToggleStatus(item)}
                            title={item.status === "ACTIVE" ? "Deactivate" : "Activate"}
                          >
                            {item.status === "ACTIVE" ? (
                              <>
                                <UserX className="h-3.5 w-3.5" />
                                Deactivate
                              </>
                            ) : (
                              <>
                                <ShieldCheck className="h-3.5 w-3.5" />
                                Activate
                              </>
                            )}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleRevokeSessions(item)}
                            title="Revoke active sessions"
                          >
                            <ShieldBan className="h-3.5 w-3.5" />
                            Revoke
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setResetTarget(item);
                              setGeneratedPassword(null);
                            }}
                            title="Issue temporary password"
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            Reset PW
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                      No users match the selected filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {usersData && usersData.totalPages > 1 && (
            <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground">
              <span>
                Page {usersData.page} of {usersData.totalPages}
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
                  disabled={page >= usersData.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Teacher or Student Account</DialogTitle>
            <DialogDescription>
              Passwords must be at least 10 characters with uppercase, lowercase, and digits.
            </DialogDescription>
          </DialogHeader>

          {createError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {createError}
            </div>
          )}

          <form onSubmit={(e) => void handleCreateUser(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="create-name">Full Name</Label>
              <Input
                id="create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-email">Email</Label>
              <Input
                id="create-email"
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-role">Role</Label>
              <select
                id="create-role"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value as "TEACHER" | "STUDENT")}
              >
                <option value="STUDENT">Student</option>
                <option value="TEACHER">Teacher</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-password">Initial Password</Label>
              <Input
                id="create-password"
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                required
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create Account
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Account Details</DialogTitle>
            <DialogDescription>
              Administrator accounts cannot be demoted through user editing.
            </DialogDescription>
          </DialogHeader>

          {editError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              {editError}
            </div>
          )}

          <form onSubmit={(e) => void handleEditUser(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="edit-name">Full Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                required
              />
            </div>
            {editTarget && editTarget.role !== "ADMIN" && (
              <div className="space-y-1">
                <Label htmlFor="edit-role">Role</Label>
                <select
                  id="edit-role"
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as "TEACHER" | "STUDENT")}
                >
                  <option value="STUDENT">Student</option>
                  <option value="TEACHER">Teacher</option>
                </select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingEdit}>
                {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Temporary Password Dialog */}
      <Dialog open={Boolean(resetTarget)} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset User Password</DialogTitle>
            <DialogDescription>
              Generates a one-time temporary password for {resetTarget?.email} and revokes all
              active sessions.
            </DialogDescription>
          </DialogHeader>

          {generatedPassword ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted p-3">
                <p className="text-xs text-muted-foreground">
                  Temporary Password (shown once — share securely):
                </p>
                <p className="mt-1 select-all font-mono text-sm font-semibold">
                  {generatedPassword}
                </p>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setResetTarget(null)}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setResetTarget(null)}>
                Cancel
              </Button>
              <Button onClick={() => void handleGenerateTemporaryPassword()} disabled={resetting}>
                {resetting && <Loader2 className="h-4 w-4 animate-spin" />}
                Generate Temporary Password
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
