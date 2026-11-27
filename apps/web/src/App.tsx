import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/components/AuthProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ToastProvider } from "@/components/ToastProvider";
import { AppShell } from "@/components/AppShell";
import { LandingOverviewPage } from "@/pages/LandingOverviewPage";
import { LoginPage } from "@/pages/LoginPage";
import { PortalPlaceholderPage } from "@/pages/PortalPlaceholderPage";
import { SecurityLimitationsPage } from "@/pages/SecurityLimitationsPage";
import { SecuritySettingsPage } from "@/pages/SecuritySettingsPage";
import { UnauthorizedPage } from "@/pages/UnauthorizedPage";
import { AdminAuditLogsPage } from "@/pages/admin/AdminAuditLogsPage";
import { AdminCourseDetailPage } from "@/pages/admin/AdminCourseDetailPage";
import { AdminCoursesPage } from "@/pages/admin/AdminCoursesPage";
import { AdminDashboardPage } from "@/pages/admin/AdminDashboardPage";
import { AdminExamDetailPage } from "@/pages/admin/AdminExamDetailPage";
import { AdminExamsPage } from "@/pages/admin/AdminExamsPage";
import { AdminProctoringPage } from "@/pages/admin/AdminProctoringPage";
import { AdminUsersPage } from "@/pages/admin/AdminUsersPage";
import { StudentAssignmentDetailPage } from "@/pages/student/StudentAssignmentDetailPage";
import { StudentAssignmentsPage } from "@/pages/student/StudentAssignmentsPage";
import { StudentCourseDetailPage } from "@/pages/student/StudentCourseDetailPage";
import { StudentCoursesPage } from "@/pages/student/StudentCoursesPage";
import { StudentDashboardPage } from "@/pages/student/StudentDashboardPage";
import { StudentExamPreflightPage } from "@/pages/student/StudentExamPreflightPage";
import { StudentExamTakingPage } from "@/pages/student/StudentExamTakingPage";
import { StudentExamsPage } from "@/pages/student/StudentExamsPage";
import { TeacherAssignmentDetailPage } from "@/pages/teacher/TeacherAssignmentDetailPage";
import { TeacherAssignmentsPage } from "@/pages/teacher/TeacherAssignmentsPage";
import { TeacherCourseDetailPage } from "@/pages/teacher/TeacherCourseDetailPage";
import { TeacherCoursesPage } from "@/pages/teacher/TeacherCoursesPage";
import { TeacherDashboardPage } from "@/pages/teacher/TeacherDashboardPage";
import { TeacherExamEditorPage } from "@/pages/teacher/TeacherExamEditorPage";
import { TeacherExamsPage } from "@/pages/teacher/TeacherExamsPage";

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <AppShell>
                <Routes>
                  <Route path="/" element={<LandingOverviewPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/unauthorized" element={<UnauthorizedPage />} />
                  <Route path="/security" element={<SecurityLimitationsPage />} />

                  <Route
                    path="/settings/security"
                    element={
                      <ProtectedRoute allowPasswordChangePending>
                        <SecuritySettingsPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Admin Routes */}
                  <Route
                    path="/admin"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminDashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/courses"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminCoursesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/courses/:id"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminCourseDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/exams"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminExamsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/exams/:id"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminExamDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/proctoring"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminProctoringPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/users"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminUsersPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/admin/audit-logs"
                    element={
                      <ProtectedRoute allowedRoles={["ADMIN"]}>
                        <AdminAuditLogsPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Teacher Routes */}
                  <Route
                    path="/teacher"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherDashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/courses"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherCoursesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/courses/:id"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherCourseDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/assignments"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherAssignmentsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/assignments/:id"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherAssignmentDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/exams"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherExamsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/teacher/exams/:id"
                    element={
                      <ProtectedRoute allowedRoles={["TEACHER"]}>
                        <TeacherExamEditorPage />
                      </ProtectedRoute>
                    }
                  />

                  {/* Student Routes */}
                  <Route
                    path="/student"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentDashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/courses"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentCoursesPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/courses/:id"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentCourseDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/assignments"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentAssignmentsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/assignments/:id"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentAssignmentDetailPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/exams"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentExamsPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/exams/:examId/preflight"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentExamPreflightPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/exams/:examId/attempt/:attemptId"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <StudentExamTakingPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/student/results"
                    element={
                      <ProtectedRoute allowedRoles={["STUDENT"]}>
                        <PortalPlaceholderPage
                          title="Exam Results"
                          phase="Phase 6"
                          description="View authorized examination results and performance analytics."
                        />
                      </ProtectedRoute>
                    }
                  />

                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </AppShell>
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
