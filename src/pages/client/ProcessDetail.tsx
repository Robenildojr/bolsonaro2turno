import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Card, StatusBadge } from "../../components/ui";
import { AnexoLink } from "../../components/AnexoLink";
import { formatCurrency, formatDate } from "../../utils/format";
import type { Andamento, Processo } from "../../types";

export default function ProcessDetail() {
  const { id } = useParams();
  const [processo, setProcesso] = useState<Processo | null>(null);
  const [andamentos, setAndamentos] = useState<Andamento[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [{ data: processoData }, { data: andamentosData }] = await Promise.all([
        supabase.from("processos").select("*").eq("id", id).single(),
        supabase.from("andamentos").select("*").eq("processo_id", id).order("data", { ascending: false }),
      ]);
      setProcesso(processoData ?? null);
      setAndamentos(andamentosData ?? []);
      setLoading(false);
    }
    load();
  }, [id]);

  if (loading) return <div className="text-sm text-brand-400">Carregando...</div>;
  if (!processo) {
    return (
      <div>
        <div className="mb-4 text-sm text-red-600">Processo não encontrado.</div>
        <Link to="/portal" className="text-sm text-brand-600 hover:underline">
          ← Voltar para meus processos
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link to="/portal" className="mb-4 inline-block text-sm text-brand-600 hover:underline">
        ← Meus processos
      </Link>

      <Card className="mb-6 p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-brand-800">{processo.numero_cnj}</h1>
          <StatusBadge status={processo.status} />
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Info label="Tipo de ação" value={processo.tipo_acao} />
          <Info label="Vara" value={processo.vara} />
          <Info label="Comarca/Tribunal" value={processo.comarca} />
          <Info label="Parte contrária" value={processo.parte_contraria} />
          <Info label="Valor da causa" value={formatCurrency(processo.valor_causa)} />
          <Info label="Data de distribuição" value={formatDate(processo.data_distribuicao)} />
        </dl>
      </Card>

      <h2 className="mb-4 text-base font-semibold text-brand-800">Andamento do processo</h2>

      {andamentos.length === 0 ? (
        <Card className="p-5 text-sm text-brand-400">Nenhuma movimentação registrada ainda.</Card>
      ) : (
        <ol className="space-y-6 border-l-2 border-brand-200 pl-6">
          {andamentos.map((a, index) => (
            <li key={a.id} className="relative">
              <span
                className={`absolute -left-[31px] top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-brand-50 ${
                  index === 0 ? "bg-gold-500" : "bg-brand-300"
                }`}
              />
              <Card className={`p-4 ${index === 0 ? "border-gold-500/60 ring-1 ring-gold-500/30" : ""}`}>
                {index === 0 && (
                  <span className="mb-2 inline-block rounded-full bg-gold-500/10 px-2.5 py-0.5 text-xs font-medium text-gold-600">
                    Mais recente
                  </span>
                )}
                <div className="mb-0.5 text-xs font-medium text-brand-400">{formatDate(a.data)}</div>
                <div className="font-medium text-brand-800">{a.titulo}</div>
                {a.descricao && <p className="mt-1 whitespace-pre-wrap text-sm text-brand-600">{a.descricao}</p>}
                {a.anexo_url && (
                  <div className="mt-3">
                    <AnexoLink path={a.anexo_url} nome={a.anexo_nome} />
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-brand-400">{label}</dt>
      <dd className="text-brand-800">{value || "-"}</dd>
    </div>
  );
}
