import { createContext, useContext } from "react";
import type { AuthenticatedUserDto, UserRole } from "@pariksha/shared";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthenticatedUserDto | null;
  sessionNotice: string | null;
  suppressNextRedirectFrom: boolean;
  clearSessionNotice: () => void;
  login: (email: string, password: string) => Promise<AuthenticatedUserDto>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  clearAuthForReauth: (notice?: string) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

export function getHomeRouteForRole(role: UserRole): string {
  switch (role) {
    case "ADMIN":
      return "/admin";
    case "TEACHER":
      return "/teacher";
    case "STUDENT":
      return "/student";
  }
}
