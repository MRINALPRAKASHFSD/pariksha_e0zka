import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { changePasswordSchema } from "@pariksha/shared";
import { useAuth } from "@/context/auth-context";
import { useToast } from "@/context/toast-context";
import { ApiClientError, apiRequest } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SecuritySettingsPage() {
  const { user, clearAuthForReauth } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    const parsed = changePasswordSchema.safeParse({ currentPassword, newPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid password input.");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest<{ passwordChanged: boolean; reauthRequired: boolean }>(
        "/auth/change-password",
        {
          method: "POST",
          skipAuthRedirect: true,
          body: JSON.stringify(parsed.data),
        },
      );

      clearAuthForReauth("Your password was changed and all active sessions were revoked. Please sign in again.");
      pushToast({
        title: "Password updated",
        description: "All sessions have been invalidated for security.",
      });
      navigate("/login", { replace: true });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to update password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account &amp; Security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your profile credentials. Changing your password revokes all active sessions.
        </p>
      </div>

      {user?.mustChangePassword && (
        <div
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
        >
          You signed in with a temporary password. You must set a new permanent password before
          accessing your workspace.
        </div>
      )}

      {user && (
        <Card>
          <CardHeader>
            <CardTitle>Authenticated Profile</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Full Name</p>
              <p className="font-medium">{user.fullName}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Email</p>
              <p className="font-medium">{user.email}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Role</p>
              <Badge variant="default" className="mt-0.5">
                {user.role}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Account Status</p>
              <Badge variant="success" className="mt-0.5">
                {user.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <CardTitle>Change Password</CardTitle>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowPasswords((prev) => !prev)}
            >
              {showPasswords ? (
                <>
                  <EyeOff className="h-4 w-4" />
                  Hide
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" />
                  Show
                </>
              )}
            </Button>
          </div>
          <CardDescription>
            Minimum 10 characters with uppercase, lowercase, and numeric characters.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            >
              {error}
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Current Password</Label>
              <Input
                id="current-password"
                type={showPasswords ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type={showPasswords ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                type={showPasswords ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Updating Password...
                </>
              ) : (
                "Update Password & Revoke Sessions"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
