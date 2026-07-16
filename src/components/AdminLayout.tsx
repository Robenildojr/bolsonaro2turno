import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

const navItems = [
  { to: "/admin", label: "Dashboard", end: true },
  { to: "/admin/clientes", label: "Clientes" },
  { to: "/admin/processos", label: "Processos" },
];

export function AdminLayout() {
  const { signOut, session } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-brand-50 md:flex-row">
      <aside className="flex shrink-0 flex-col justify-between border-b border-brand-200 bg-brand-800 text-white md:min-h-screen md:w-60 md:border-b-0 md:border-r">
        <div>
          <div className="px-5 py-5 text-lg font-semibold tracking-tight">
            Portal Jurídico
            <div className="text-xs font-normal text-brand-300">Área do Administrador</div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? "bg-brand-600 text-white" : "text-brand-200 hover:bg-brand-700 hover:text-white"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="border-t border-brand-700 px-5 py-4 text-xs text-brand-300">
          <div className="mb-2 truncate">{session?.user.email}</div>
          <button
            onClick={() => signOut()}
            className="w-full rounded-md border border-brand-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-brand-700"
          >
            Sair
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}
