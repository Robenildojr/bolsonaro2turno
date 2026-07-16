import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Card, PageHeader, StatusBadge } from "../../components/ui";
import { formatDate } from "../../utils/format";
import type { Andamento, Processo } from "../../types";

interface Stats {
  totalClientes: number;
  processosAtivos: number;
  totalProcessos: number;
}

interface AndamentoComProcesso extends Andamento {
  processos: Pick<Processo, "id" | "numero_cnj"> | null;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentes, setRecentes] = useState<AndamentoComProcesso[]>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Processo[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    async function loadStats() {
      const [{ count: totalClientes }, { count: processosAtivos }, { count: totalProcessos }, { data: andamentos }] =
        await Promise.all([
          supabase.from("clientes").select("*", { count: "exact", head: true }),
          supabase.from("processos").select("*", { count: "exact", head: true }).eq("status", "ativo"),
          supabase.from("processos").select("*", { count: "exact", head: true }),
          supabase
            .from("andamentos")
            .select("*, processos(id, numero_cnj)")
            .order("data", { ascending: false })
            .limit(5),
        ]);

      setStats({
        totalClientes: totalClientes ?? 0,
        processosAtivos: processosAtivos ?? 0,
        totalProcessos: totalProcessos ?? 0,
      });
      setRecentes((andamentos as AndamentoComProcesso[] | null) ?? []);
    }
    loadStats();
  }, []);

  useEffect(() => {
    const term = search.trim();
    if (!term) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timeout = setTimeout(async () => {
      const [byNumero, porCliente] = await Promise.all([
        supabase.from("processos").select("*, clientes(nome)").ilike("numero_cnj", `%${term}%`).limit(10),
        supabase
          .from("processos")
          .select("*, clientes!inner(nome)")
          .ilike("clientes.nome", `%${term}%`)
          .limit(10),
      ]);
      const merged = new Map<string, Processo>();
      for (const p of [...(byNumero.data ?? []), ...(porCliente.data ?? [])]) merged.set(p.id, p as Processo);
      setSearchResults(Array.from(merged.values()));
      setSearching(false);
    }, 300);
    return () => clearTimeout(timeout);
  }, [search]);

  return (
    <div>
      <PageHeader title="Dashboard" />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="text-sm text-brand-500">Clientes cadastrados</div>
          <div className="mt-1 text-3xl font-semibold text-brand-800">{stats?.totalClientes ?? "-"}</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-brand-500">Processos ativos</div>
          <div className="mt-1 text-3xl font-semibold text-brand-800">{stats?.processosAtivos ?? "-"}</div>
        </Card>
        <Card className="p-5">
          <div className="text-sm text-brand-500">Total de processos</div>
          <div className="mt-1 text-3xl font-semibold text-brand-800">{stats?.totalProcessos ?? "-"}</div>
        </Card>
      </div>

      <Card className="mb-6 p-5">
        <div className="mb-3 text-sm font-medium text-brand-700">Buscar por cliente ou nº do processo</div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Digite o nome do cliente ou o número CNJ..."
          className="w-full rounded-md border border-brand-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
        />
        {search.trim() && (
          <div className="mt-3 divide-y divide-brand-100 border-t border-brand-100">
            {searching && <div className="py-2 text-sm text-brand-400">Buscando...</div>}
            {!searching && searchResults.length === 0 && (
              <div className="py-2 text-sm text-brand-400">Nenhum processo encontrado.</div>
            )}
            {searchResults.map((p) => (
              <Link
                key={p.id}
                to={`/admin/processos/${p.id}`}
                className="flex items-center justify-between py-2 text-sm hover:text-brand-700"
              >
                <span>
                  {p.numero_cnj} — {(p as unknown as { clientes: { nome: string } }).clientes?.nome}
                </span>
                <StatusBadge status={p.status} />
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 text-sm font-medium text-brand-700">Andamentos recentes</div>
        {recentes.length === 0 && <div className="text-sm text-brand-400">Nenhum andamento registrado ainda.</div>}
        <ul className="divide-y divide-brand-100">
          {recentes.map((a) => (
            <li key={a.id} className="py-2.5">
              <Link to={`/admin/processos/${a.processos?.id}`} className="flex justify-between gap-3 text-sm">
                <span className="font-medium text-brand-800">{a.titulo}</span>
                <span className="shrink-0 text-brand-400">{formatDate(a.data)}</span>
              </Link>
              <div className="text-xs text-brand-500">{a.processos?.numero_cnj}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
