import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../contexts/AuthContext";
import { cpfToInternalEmail, isValidCpf, maskCpf } from "../utils/cpf";

type Tab = "cliente" | "admin";

export default function Login() {
  const { session, profile, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<Tab>("cliente");
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!authLoading && session && profile) {
    return <Navigate to={profile.role === "admin" ? "/admin" : "/portal"} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (tab === "cliente" && !isValidCpf(cpf)) {
      setError("CPF inválido. Confira os números digitados.");
      return;
    }

    setSubmitting(true);
    const { error: signInError } =
      tab === "cliente"
        ? await supabase.auth.signInWithPassword({
            email: cpfToInternalEmail(cpf),
            password,
          })
        : await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);

    if (signInError) {
      setError("CPF/e-mail ou senha inválidos.");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-semibold tracking-tight text-brand-800">Portal Jurídico</div>
          <div className="mt-1 text-sm text-brand-500">Acompanhamento de processos</div>
        </div>

        <div className="rounded-xl border border-brand-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex rounded-lg bg-brand-100 p-1 text-sm font-medium">
            <button
              type="button"
              onClick={() => {
                setTab("cliente");
                setError(null);
              }}
              className={`flex-1 rounded-md py-2 transition-colors ${
                tab === "cliente" ? "bg-white text-brand-800 shadow-sm" : "text-brand-500"
              }`}
            >
              Portal do Cliente
            </button>
            <button
              type="button"
              onClick={() => {
                setTab("admin");
                setError(null);
              }}
              className={`flex-1 rounded-md py-2 transition-colors ${
                tab === "admin" ? "bg-white text-brand-800 shadow-sm" : "text-brand-500"
              }`}
            >
              Administrador
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {tab === "cliente" ? (
              <div>
                <label htmlFor="cpf" className="mb-1 block text-sm font-medium text-brand-700">
                  CPF
                </label>
                <input
                  id="cpf"
                  inputMode="numeric"
                  autoComplete="username"
                  placeholder="000.000.000-00"
                  value={cpf}
                  onChange={(e) => setCpf(maskCpf(e.target.value))}
                  maxLength={14}
                  className="w-full rounded-md border border-brand-200 px-3 py-2 text-brand-900 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  required
                />
              </div>
            ) : (
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-brand-700">
                  E-mail
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-brand-200 px-3 py-2 text-brand-900 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                  required
                />
              </div>
            )}

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium text-brand-700">
                Senha
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-brand-200 px-3 py-2 text-brand-900 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                required
              />
              {tab === "cliente" && (
                <p className="mt-1 text-xs text-brand-400">
                  No primeiro acesso, a senha é o seu próprio CPF (somente números).
                </p>
              )}
            </div>

            {error && (
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-brand-700 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Entrando..." : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
