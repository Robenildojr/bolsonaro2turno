import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Card, StatusBadge } from "../../components/ui";
import type { Processo } from "../../types";

export default function ProcessList() {
  const [processos, setProcessos] = useState<Processo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("processos").select("*").order("created_at", { ascending: false });
      setProcessos(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-brand-800">Meus processos</h1>
      <p className="mb-6 text-sm text-brand-500">Selecione um processo para ver o andamento detalhado.</p>

      {loading ? (
        <div className="text-sm text-brand-400">Carregando...</div>
      ) : processos.length === 0 ? (
        <Card className="p-6 text-sm text-brand-400">Nenhum processo vinculado ao seu cadastro ainda.</Card>
      ) : (
        <div className="space-y-3">
          {processos.map((p) => (
            <Link key={p.id} to={`/portal/processos/${p.id}`}>
              <Card className="p-5 transition-shadow hover:shadow-md">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <span className="font-medium text-brand-800">{p.numero_cnj}</span>
                  <StatusBadge status={p.status} />
                </div>
                <div className="text-sm text-brand-500">{p.tipo_acao ?? "Tipo de ação não informado"}</div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
