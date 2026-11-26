import React, { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2, LockKeyhole, ShieldAlert } from "lucide-react";
import { loginSchema, type UserRole } from "@pariksha/shared";
import { getHomeRouteForRole, useAuth } from "@/context/auth-context";
import { useToast } from "@/context/toast-context";
import { ApiClientError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function isPathAllowedForRole(path: string, role: UserRole): boolean {
  if (path.startsWith("/admin")) return role === "ADMIN";
  if (path.startsWith("/teacher")) return role === "TEACHER";
  if (path.startsWith("/student")) return role === "STUDENT";
  return true;
}

export function LoginPage() {
  const { status, user, login, sessionNotice, clearSessionNotice } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const submittingLoginRef = useRef(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const intendedPath = (location.state as { from?: string } | null)?.from;

  useEffect(() => {
    if (status === "authenticated" && user && !submittingLoginRef.current) {
      if (user.mustChangePassword) {
        navigate("/settings/security", { replace: true });
        return;
      }
      const target =
        intendedPath &&
        intendedPath !== "/login" &&
        intendedPath !== "/unauthorized" &&
        isPathAllowedForRole(intendedPath, user.role)
          ? intendedPath
          : getHomeRouteForRole(user.role);
      navigate(target, { replace: true });
    }
  }, [status, user, navigate, intendedPath]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    clearSessionNotice();

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Please enter valid credentials.";
      setFormError(firstIssue);
      return;
    }

    setSubmitting(true);
    submittingLoginRef.current = true;
    try {
      const authenticatedUser = await login(parsed.data.email, parsed.data.password);
      pushToast({
        title: "Signed in",
        description: authenticatedUser.mustChangePassword
          ? "Please change your temporary password to continue."
          : `Welcome back, ${authenticatedUser.fullName}`,
      });
      navigate(
        authenticatedUser.mustChangePassword
          ? "/settings/security"
          : getHomeRouteForRole(authenticatedUser.role),
        { replace: true },
      );
    } catch (err) {
      submittingLoginRef.current = false;
      if (err instanceof ApiClientError) {
        setFormError(err.message);
      } else {
        setFormError("Unable to reach authentication service. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col justify-center py-8">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <LockKeyhole className="h-5 w-5" />
          </div>
          <CardTitle className="text-xl">Sign in to Pariksha</CardTitle>
          <CardDescription>
            Authenticate with your institutional credentials. Sessions use secure HttpOnly cookies.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {sessionNotice && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{sessionNotice}</span>
            </div>
          )}

          {formError && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            >
              {formError}
            </div>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Institutional Email</Label>
              <Input
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="name@institution.edu"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <div className="relative">
                <Input
                  id="login-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  className="pr-10"
                  required
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
