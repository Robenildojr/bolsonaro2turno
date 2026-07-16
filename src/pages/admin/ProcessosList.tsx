import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Card, PageHeader, StatusBadge } from "../../components/ui";
import { formatDate } from "../../utils/format";
import { STATUS_LABELS, type Processo, type ProcessoStatus } from "../../types";

interface ProcessoComCliente extends Processo {
  clientes: { nome: string } | null;
}

export default function ProcessosList() {
  const [processos, setProcessos] = useState<ProcessoComCliente[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProcessoStatus | "todos">("todos");

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from("processos")
        .select("*, clientes(nome)")
        .order("created_at", { ascending: false });
      setProcessos((data as ProcessoComCliente[] | null) ?? []);
      setLoading(false);
    }
    load();
  }, []);

  const filtered = processos.filter((p) => {
    if (statusFilter !== "todos" && p.status !== statusFilter) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return p.numero_cnj.toLowerCase().includes(term) || (p.clientes?.nome ?? "").toLowerCase().includes(term);
  });

  return (
    <div>
      <PageHeader
        title="Processos"
        actions={
          <Link
            to="/admin/processos/novo"
            className="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            + Novo processo
          </Link>
        }
      />

      <Card className="mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nº CNJ ou cliente..."
          className="input sm:flex-1"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ProcessoStatus | "todos")}
          className="input sm:w-48"
        >
          <option value="todos">Todos os status</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Card>

      <Card className="overflow-x-auto">
        {loading ? (
          <div className="p-6 text-sm text-brand-400">Carregando...</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-brand-400">Nenhum processo encontrado.</div>
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-brand-100 text-brand-500">
              <tr>
                <th className="px-4 py-3 font-medium">Nº CNJ</th>
                <th className="px-4 py-3 font-medium">Cliente</th>
                <th className="px-4 py-3 font-medium">Tipo de ação</th>
                <th className="px-4 py-3 font-medium">Distribuição</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-100">
              {filtered.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-brand-50">
                  <td className="px-4 py-3">
                    <Link to={`/admin/processos/${p.id}`} className="font-medium text-brand-800 hover:underline">
                      {p.numero_cnj}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-brand-600">{p.clientes?.nome ?? "-"}</td>
                  <td className="px-4 py-3 text-brand-600">{p.tipo_acao ?? "-"}</td>
                  <td className="px-4 py-3 text-brand-600">{formatDate(p.data_distribuicao)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
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
