import { Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export function ClientLayout() {
  const { signOut } = useAuth();

  return (
    <div className="min-h-screen bg-brand-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-brand-200 bg-white px-4 py-3 shadow-sm md:px-8">
        <div className="text-base font-semibold tracking-tight text-brand-800">Portal Jurídico</div>
        <button
          onClick={() => signOut()}
          className="rounded-md border border-brand-300 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
        >
          Sair
        </button>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
