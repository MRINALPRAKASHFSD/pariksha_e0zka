import React, { useCallback, useEffect, useState } from "react";
import type { AuthSessionPayload, AuthenticatedUserDto } from "@pariksha/shared";
import { AuthContext, type AuthStatus } from "@/context/auth-context";
import {
  apiRequest,
  ensureCsrfToken,
  registerSessionExpiredHandler,
  setInMemoryCsrfToken,
} from "@/lib/api";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthenticatedUserDto | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [suppressNextRedirectFrom, setSuppressNextRedirectFrom] = useState(false);

  const clearAuthForReauth = useCallback((notice?: string) => {
    setInMemoryCsrfToken(null);
    setUser(null);
    setStatus("unauthenticated");
    if (notice) {
      setSessionNotice(notice);
    }
  }, []);

  useEffect(() => {
    registerSessionExpiredHandler((reason) => {
      clearAuthForReauth(reason || "Your session has expired. Please sign in again.");
    });
    return () => registerSessionExpiredHandler(null);
  }, [clearAuthForReauth]);

  const refreshSession = useCallback(async () => {
    try {
      const data = await apiRequest<AuthSessionPayload>("/auth/me", {
        method: "GET",
        skipAuthRedirect: true,
      });
      setInMemoryCsrfToken(data.csrfToken);
      setUser(data.user);
      setStatus("authenticated");
      setSessionNotice(null);
    } catch {
      setInMemoryCsrfToken(null);
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(async (email: string, password: string) => {
    // Always fetch pre-auth CSRF token bound to HttpOnly pre-auth cookie before login
    setInMemoryCsrfToken(null);
    await ensureCsrfToken();
    const data = await apiRequest<AuthSessionPayload>("/auth/login", {
      method: "POST",
      skipAuthRedirect: true,
      body: JSON.stringify({ email, password }),
    });
    setInMemoryCsrfToken(data.csrfToken);
    setUser(data.user);
    setStatus("authenticated");
    setSessionNotice(null);
    setSuppressNextRedirectFrom(false);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    setSuppressNextRedirectFrom(true);
    try {
      await apiRequest<{ loggedOut: boolean }>("/auth/logout", {
        method: "POST",
        skipAuthRedirect: true,
      });
    } finally {
      setInMemoryCsrfToken(null);
      setUser(null);
      setStatus("unauthenticated");
      setSessionNotice(null);
    }
  }, []);

  const clearSessionNotice = useCallback(() => setSessionNotice(null), []);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        sessionNotice,
        suppressNextRedirectFrom,
        clearSessionNotice,
        login,
        logout,
        refreshSession,
        clearAuthForReauth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
