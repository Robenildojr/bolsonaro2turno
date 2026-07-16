import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../contexts/AuthContext";

export default function ChangePassword() {
  const { profile, refreshProfile, signOut } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("A nova senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      setError("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);
    const { error: updateErr } = await supabase.auth.updateUser({ password });
    if (updateErr) {
      setSubmitting(false);
      setError("Não foi possível alterar a senha. Tente novamente.");
      return;
    }

    if (profile) {
      await supabase.from("profiles").update({ must_change_password: false }).eq("id", profile.id);
    }
    await refreshProfile();
    setSubmitting(false);
    navigate("/portal", { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-xl font-semibold tracking-tight text-brand-800">Defina sua nova senha</div>
          <p className="mt-2 text-sm text-brand-500">
            Por segurança, você precisa trocar a senha inicial (seu CPF) antes de continuar.
          </p>
        </div>

        <div className="rounded-xl border border-brand-200 bg-white p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="new-password" className="mb-1 block text-sm font-medium text-brand-700">
                Nova senha
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-brand-200 px-3 py-2 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                required
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className="mb-1 block text-sm font-medium text-brand-700">
                Confirmar nova senha
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-brand-200 px-3 py-2 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                required
              />
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
              {submitting ? "Salvando..." : "Salvar nova senha"}
            </button>
            <button
              type="button"
              onClick={() => signOut()}
              className="w-full text-center text-sm text-brand-500 hover:text-brand-700"
            >
              Sair
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
