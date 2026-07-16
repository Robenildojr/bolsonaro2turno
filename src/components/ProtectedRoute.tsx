import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import type { Role } from "../types";

export function ProtectedRoute({
  role,
  requirePasswordChanged = true,
}: {
  role: Role;
  requirePasswordChanged?: boolean;
}) {
  const { session, profile, loading } = useAuth();

  if (loading) return <FullPageSpinner />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  if (profile.role !== role) {
    return <Navigate to={profile.role === "admin" ? "/admin" : "/portal"} replace />;
  }
  if (role === "cliente" && requirePasswordChanged && profile.must_change_password) {
    return <Navigate to="/portal/trocar-senha" replace />;
  }

  return <Outlet />;
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full min-h-screen items-center justify-center bg-brand-50">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-200 border-t-brand-600" />
    </div>
  );
}
