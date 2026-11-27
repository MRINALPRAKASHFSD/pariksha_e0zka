import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { UserRole } from "@pariksha/shared";
import { useAuth } from "@/context/auth-context";
import { Skeleton } from "@/components/ui/skeleton";

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
  allowPasswordChangePending?: boolean;
}

export function ProtectedRoute({
  children,
  allowedRoles,
  allowPasswordChangePending = false,
}: ProtectedRouteProps) {
  const { status, user, suppressNextRedirectFrom } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="mx-auto max-w-4xl space-y-4 py-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (status === "unauthenticated" || !user) {
    return (
      <Navigate
        to="/login"
        state={suppressNextRedirectFrom ? null : { from: location.pathname }}
        replace
      />
    );
  }

  if (user.mustChangePassword && !allowPasswordChangePending) {
    return <Navigate to="/settings/security" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
}
