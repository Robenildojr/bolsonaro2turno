import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Banner, Card, PageHeader } from "../../components/ui";
import { maskCpf } from "../../utils/cpf";
import type { Cliente } from "../../types";

export default function ClientesList() {
  const location = useLocation();
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const message = (location.state as { message?: string } | null)?.message ?? null;

  async function load() {
    setLoading(true);
    const { data, error: fetchError } = await supabase.from("clientes").select("*").order("nome");
    if (fetchError) setError(fetchError.message);
    setClientes(data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(cliente: Cliente) {
    if (!confirm(`Excluir o cliente "${cliente.nome}"? Isso remove também seus processos e o acesso ao portal.`)) {
      return;
    }
    setDeletingId(cliente.id);
    setError(null);
    const { error: fnError } = await supabase.functions.invoke("manage-client-user", {
      body: { action: "delete", clienteId: cliente.id },
    });
    if (fnError) {
      setError("Não foi possível remover o acesso do cliente: " + fnError.message);
      setDeletingId(null);
      return;
    }
    const { error: deleteError } = await supabase.from("clientes").delete().eq("id", cliente.id);
    setDeletingId(null);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setClientes((prev) => prev.filter((c) => c.id !== cliente.id));
  }

  const filtered = clientes.filter((c) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return c.nome.toLowerCase().includes(term) || c.cpf.includes(term.replace(/\D/g, ""));
  });

  return (
    <div>
      <PageHeader
        title="Clientes"
        actions={
          <Link
            to="/admin/clientes/novo"
            className="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            + Novo cliente
          </Link>
        }
      />

      {message && (
        <div className="mb-4">
          <Banner kind="success">{message}</Banner>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Banner kind="error">{error}</Banner>
        </div>
      )}

      <Card className="mb-4 p-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou CPF..."
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
      </Card>

      <Card className="overflow-x-auto">
        {loading ? (
          <div className="p-6 text-sm text-brand-400">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-brand-400">Nenhum cliente encontrado.</div>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-brand-100 text-brand-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nome</th>
                <th className="px-4 py-3 font-medium">CPF</th>
                <th className="px-4 py-3 font-medium">Contato</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-100">
              {filtered.map((cliente) => (
                <tr key={cliente.id}>
                  <td className="px-4 py-3 font-medium text-brand-800">{cliente.nome}</td>
                  <td className="px-4 py-3 text-brand-600">{maskCpf(cliente.cpf)}</td>
                  <td className="px-4 py-3 text-brand-600">
                    <div>{cliente.email}</div>
                    <div className="text-xs text-brand-400">{cliente.telefone}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3">
                      <Link to={`/admin/clientes/${cliente.id}/editar`} className="text-brand-600 hover:underline">
                        Editar
                      </Link>
                      <button
                        onClick={() => handleDelete(cliente)}
                        disabled={deletingId === cliente.id}
                        className="text-red-600 hover:underline disabled:opacity-50"
                      >
                        {deletingId === cliente.id ? "Excluindo..." : "Excluir"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
