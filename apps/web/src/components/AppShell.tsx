import React, { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BookOpen,
  ClipboardCheck,
  FileText,
  GraduationCap,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Moon,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/context/theme-context";
import { getHomeRouteForRole, useAuth } from "@/context/auth-context";
import { useToast } from "@/context/toast-context";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { theme, toggleTheme } = useTheme();
  const { status, user, logout } = useAuth();
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Distraction-free exam workspace hides portal navigation chrome during active exam attempts
  const isExamFocusMode = /^\/student\/exams\/[^/]+\/attempt\/[^/]+/.test(location.pathname);

  const navItems: NavItem[] = (() => {
    if (status === "authenticated" && user) {
      if (user.role === "ADMIN") {
        return [
          { to: "/admin", label: "Admin Overview", icon: LayoutDashboard },
          { to: "/admin/courses", label: "Courses & Enrollments", icon: BookOpen },
          { to: "/admin/exams", label: "Examinations", icon: ClipboardCheck },
          { to: "/admin/proctoring", label: "Proctoring Control", icon: ShieldAlert, badge: "Phase 5" },
          { to: "/admin/users", label: "User Management", icon: Users },
          { to: "/admin/audit-logs", label: "Audit Logs", icon: ScrollText },
          { to: "/settings/security", label: "Account & Password", icon: KeyRound },
          { to: "/security", label: "Proctoring & Limits", icon: ShieldCheck },
        ];
      }
      if (user.role === "TEACHER") {
        return [
          { to: "/teacher", label: "Teacher Dashboard", icon: LayoutDashboard },
          { to: "/teacher/courses", label: "My Courses", icon: BookOpen },
          { to: "/teacher/assignments", label: "Assignments", icon: FileText },
          { to: "/teacher/exams", label: "Examinations", icon: ClipboardCheck, badge: "Phase 4" },
          { to: "/settings/security", label: "Account & Password", icon: KeyRound },
          { to: "/security", label: "Proctoring & Limits", icon: ShieldCheck },
        ];
      }
      return [
        { to: "/student", label: "Student Dashboard", icon: LayoutDashboard },
        { to: "/student/courses", label: "My Courses", icon: BookOpen },
        { to: "/student/assignments", label: "Assignments", icon: FileText },
        { to: "/student/exams", label: "Examinations", icon: ClipboardCheck, badge: "Phase 4" },
        { to: "/student/results", label: "Exam Results", icon: GraduationCap, badge: "Phase 6" },
        { to: "/settings/security", label: "Account & Password", icon: KeyRound },
        { to: "/security", label: "Proctoring & Limits", icon: ShieldCheck },
      ];
    }

    return [
      { to: "/", label: "Platform Status", icon: Activity },
      { to: "/login", label: "Sign In", icon: LogIn },
      { to: "/security", label: "Proctoring & Limits", icon: ShieldCheck },
    ];
  })();

  const handleLogout = async () => {
    await logout();
    pushToast({ title: "Signed out", description: "Your session has been revoked." });
    navigate("/login", { replace: true });
  };

  const renderNavLinks = (onNavigate?: () => void) =>
    navItems.map((item) => {
      const Icon = item.icon;
      const active =
        location.pathname === item.to ||
        (item.to !== "/" &&
          item.to !== "/admin" &&
          item.to !== "/teacher" &&
          item.to !== "/student" &&
          location.pathname.startsWith(`${item.to}/`));
      return (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={cn(
            "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors",
            active
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <span className="flex items-center gap-2.5">
            <Icon className="h-4 w-4" />
            {item.label}
          </span>
          {item.badge && (
            <Badge variant="outline" className="text-[10px]">
              {item.badge}
            </Badge>
          )}
        </Link>
      );
    });

  if (isExamFocusMode) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="mx-auto max-w-7xl p-4 md:p-6">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Desktop Sidebar */}
      <aside className="hidden w-64 shrink-0 border-r bg-card md:flex md:flex-col">
        <Link
          to={user ? getHomeRouteForRole(user.role) : "/"}
          className="flex h-16 items-center gap-2.5 border-b px-5"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-semibold">
            P
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight">Pariksha</p>
            <p className="text-[11px] text-muted-foreground">Exam &amp; Proctoring</p>
          </div>
        </Link>

        <nav className="flex-1 space-y-1 p-3" aria-label="Primary navigation">
          {renderNavLinks()}
        </nav>

        <div className="border-t p-3 space-y-2">
          {user ? (
            <div className="rounded-md bg-muted/60 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium text-foreground">{user.fullName}</p>
                <Badge variant="default" className="text-[10px]">
                  {user.role}
                </Badge>
              </div>
              <p className="mt-0.5 truncate text-muted-foreground">{user.email}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2.5 w-full"
                onClick={() => void handleLogout()}
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </Button>
            </div>
          ) : (
            <div className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Secure Cookie Auth</p>
              <p className="mt-1">Sign in to access your institutional workspace.</p>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="fixed inset-0 bg-background/80 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-50 flex w-64 flex-col border-r bg-card">
            <div className="flex h-16 items-center justify-between border-b px-5">
              <span className="text-sm font-semibold">Pariksha</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close navigation menu"
                onClick={() => setMobileOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <nav className="flex-1 space-y-1 p-3">{renderNavLinks(() => setMobileOpen(false))}</nav>
            {user && (
              <div className="border-t p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setMobileOpen(false);
                    void handleLogout();
                  }}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign Out
                </Button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex flex-1 flex-col min-w-0">
        <header className="flex h-16 items-center justify-between border-b bg-card px-4 md:px-6">
          <div className="flex items-center gap-3 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open navigation menu"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <span className="truncate text-sm font-medium text-muted-foreground">
              Institutional Examination &amp; Proctoring Control Plane
            </span>
          </div>

          <div className="flex items-center gap-2">
            {status === "authenticated" && user ? (
              <Button
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => navigate(getHomeRouteForRole(user.role))}
              >
                {user.role} Portal
              </Button>
            ) : (
              location.pathname !== "/login" && (
                <Button variant="default" size="sm" onClick={() => navigate("/login")}>
                  <LogIn className="h-4 w-4" />
                  Sign In
                </Button>
              )
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            >
              {theme === "light" ? (
                <>
                  <Moon className="h-4 w-4" />
                  <span className="hidden sm:inline">Dark</span>
                </>
              ) : (
                <>
                  <Sun className="h-4 w-4" />
                  <span className="hidden sm:inline">Light</span>
                </>
              )}
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
