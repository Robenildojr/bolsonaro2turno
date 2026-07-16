import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./contexts/AuthContext";
import { ProtectedRoute, FullPageSpinner } from "./components/ProtectedRoute";
import { AdminLayout } from "./components/AdminLayout";
import { ClientLayout } from "./components/ClientLayout";
import Login from "./pages/Login";
import Dashboard from "./pages/admin/Dashboard";
import ClientesList from "./pages/admin/ClientesList";
import ClienteForm from "./pages/admin/ClienteForm";
import ProcessosList from "./pages/admin/ProcessosList";
import ProcessoForm from "./pages/admin/ProcessoForm";
import ProcessoDetail from "./pages/admin/ProcessoDetail";
import ChangePassword from "./pages/client/ChangePassword";
import ClientProcessList from "./pages/client/ProcessList";
import ClientProcessDetail from "./pages/client/ProcessDetail";

function Home() {
  const { session, profile, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!session || !profile) return <Navigate to="/login" replace />;
  return <Navigate to={profile.role === "admin" ? "/admin" : "/portal"} replace />;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />

      <Route element={<ProtectedRoute role="admin" />}>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="clientes" element={<ClientesList />} />
          <Route path="clientes/novo" element={<ClienteForm />} />
          <Route path="clientes/:id/editar" element={<ClienteForm />} />
          <Route path="processos" element={<ProcessosList />} />
          <Route path="processos/novo" element={<ProcessoForm />} />
          <Route path="processos/:id" element={<ProcessoDetail />} />
          <Route path="processos/:id/editar" element={<ProcessoForm />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute role="cliente" requirePasswordChanged={false} />}>
        <Route path="/portal/trocar-senha" element={<ChangePassword />} />
      </Route>

      <Route element={<ProtectedRoute role="cliente" />}>
        <Route path="/portal" element={<ClientLayout />}>
          <Route index element={<ClientProcessList />} />
          <Route path="processos/:id" element={<ClientProcessDetail />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
