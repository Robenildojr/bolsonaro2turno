import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Banner, Card, Field, PageHeader, StatusBadge } from "../../components/ui";
import { AnexoLink } from "../../components/AnexoLink";
import { formatCurrency, formatDate, todayISO } from "../../utils/format";
import { removeAnexo, removeProcessoAnexos, uploadAnexo } from "../../utils/storage";
import type { Andamento, Cliente, Processo } from "../../types";

interface ProcessoComCliente extends Processo {
  clientes: Cliente | null;
}

export default function ProcessoDetail() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [processo, setProcesso] = useState<ProcessoComCliente | null>(null);
  const [andamentos, setAndamentos] = useState<Andamento[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(
    (location.state as { message?: string } | null)?.message ?? null,
  );
  const [deleting, setDeleting] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: processoData, error: processoError }, { data: andamentosData }] = await Promise.all([
      supabase.from("processos").select("*, clientes(*)").eq("id", id).single(),
      supabase.from("andamentos").select("*").eq("processo_id", id).order("data", { ascending: false }),
    ]);
    if (processoError) setError(processoError.message);
    setProcesso((processoData as ProcessoComCliente | null) ?? null);
    setAndamentos(andamentosData ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, [id]);

  async function handleDeleteProcesso() {
    if (!processo) return;
    if (!confirm(`Excluir o processo ${processo.numero_cnj}? Todos os andamentos serão removidos.`)) return;
    setDeleting(true);
    await removeProcessoAnexos(processo.id);
    const { error: deleteError } = await supabase.from("processos").delete().eq("id", processo.id);
    setDeleting(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    navigate("/admin/processos");
  }

  if (loading) return <div className="p-6 text-sm text-brand-400">Carregando...</div>;
  if (!processo) return <div className="p-6 text-sm text-red-600">Processo não encontrado.</div>;

  return (
    <div>
      <PageHeader
        title={processo.numero_cnj}
        actions={
          <div className="flex gap-2">
            <Link
              to={`/admin/processos/${processo.id}/editar`}
              className="rounded-md border border-brand-200 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-100"
            >
              Editar
            </Link>
            <button
              onClick={handleDeleteProcesso}
              disabled={deleting}
              className="rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {deleting ? "Excluindo..." : "Excluir"}
            </button>
          </div>
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

      <Card className="mb-6 p-6">
        <div className="mb-3 flex items-center gap-3">
          <StatusBadge status={processo.status} />
          <Link to={`/admin/clientes/${processo.cliente_id}/editar`} className="text-sm text-brand-600 hover:underline">
            {processo.clientes?.nome}
          </Link>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Info label="Tipo de ação" value={processo.tipo_acao} />
          <Info label="Vara" value={processo.vara} />
          <Info label="Comarca/Tribunal" value={processo.comarca} />
          <Info label="Parte contrária" value={processo.parte_contraria} />
          <Info label="Valor da causa" value={formatCurrency(processo.valor_causa)} />
          <Info label="Data de distribuição" value={formatDate(processo.data_distribuicao)} />
        </dl>
        {processo.observacoes && (
          <div className="mt-4 border-t border-brand-100 pt-4 text-sm">
            <div className="mb-1 font-medium text-brand-700">Observações</div>
            <p className="whitespace-pre-wrap text-brand-600">{processo.observacoes}</p>
          </div>
        )}
      </Card>

      <AndamentosSection
        processoId={processo.id}
        andamentos={andamentos}
        onChange={(next) => setAndamentos(next)}
        setMessage={setMessage}
      />
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

function AndamentosSection({
  processoId,
  andamentos,
  onChange,
  setMessage,
}: {
  processoId: string;
  andamentos: Andamento[];
  onChange: (next: Andamento[]) => void;
  setMessage: (msg: string | null) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Andamento | null>(null);

  function refresh() {
    supabase
      .from("andamentos")
      .select("*")
      .eq("processo_id", processoId)
      .order("data", { ascending: false })
      .then(({ data }) => onChange(data ?? []));
  }

  async function handleDelete(andamento: Andamento) {
    if (!confirm(`Excluir o andamento "${andamento.titulo}"?`)) return;
    if (andamento.anexo_url) await removeAnexo(andamento.anexo_url);
    const { error } = await supabase.from("andamentos").delete().eq("id", andamento.id);
    if (!error) {
      onChange(andamentos.filter((a) => a.id !== andamento.id));
      setMessage("Andamento excluído.");
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-sm font-medium text-brand-700">Andamentos</div>
        {!showForm && (
          <button
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
            className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800"
          >
            + Adicionar andamento
          </button>
        )}
      </div>

      {showForm && (
        <AndamentoForm
          processoId={processoId}
          andamento={editing}
          onCancel={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            refresh();
            setMessage("Andamento salvo com sucesso.");
          }}
        />
      )}

      {andamentos.length === 0 ? (
        <div className="text-sm text-brand-400">Nenhum andamento registrado ainda.</div>
      ) : (
        <ol className="space-y-4 border-l-2 border-brand-100 pl-5">
          {andamentos.map((a, index) => (
            <li key={a.id} className="relative">
              <span
                className={`absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white ${
                  index === 0 ? "bg-gold-500" : "bg-brand-300"
                }`}
              />
              <div className="mb-0.5 text-xs font-medium text-brand-400">{formatDate(a.data)}</div>
              <div className="font-medium text-brand-800">{a.titulo}</div>
              {a.descricao && <p className="mt-1 whitespace-pre-wrap text-sm text-brand-600">{a.descricao}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {a.anexo_url && <AnexoLink path={a.anexo_url} nome={a.anexo_nome} />}
                <button
                  onClick={() => {
                    setEditing(a);
                    setShowForm(true);
                  }}
                  className="text-xs font-medium text-brand-500 hover:underline"
                >
                  Editar
                </button>
                <button onClick={() => handleDelete(a)} className="text-xs font-medium text-red-500 hover:underline">
                  Excluir
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function AndamentoForm({
  processoId,
  andamento,
  onCancel,
  onSaved,
}: {
  processoId: string;
  andamento: Andamento | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState(andamento?.data ?? todayISO());
  const [titulo, setTitulo] = useState(andamento?.titulo ?? "");
  const [descricao, setDescricao] = useState(andamento?.descricao ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    try {
      let anexoUrl = andamento?.anexo_url ?? null;
      let anexoNome = andamento?.anexo_nome ?? null;
      if (file) {
        const uploaded = await uploadAnexo(processoId, file);
        anexoUrl = uploaded.path;
        anexoNome = uploaded.nome;
      }

      const payload = { processo_id: processoId, data, titulo, descricao: descricao || null, anexo_url: anexoUrl, anexo_nome: anexoNome };

      const result = andamento
        ? await supabase.from("andamentos").update(payload).eq("id", andamento.id)
        : await supabase.from("andamentos").insert(payload);

      if (result.error) throw result.error;
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 space-y-4 rounded-lg border border-brand-100 bg-brand-50 p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Data" required>
          <input type="date" value={data} onChange={(e) => setData(e.target.value)} required className="input" />
        </Field>
        <Field label="Título/tipo" required>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} required className="input" />
        </Field>
      </div>
      <Field label="Descrição detalhada">
        <textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={3} className="input" />
      </Field>
      <Field label="Anexo (opcional)">
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-brand-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-200 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-800"
        />
        {andamento?.anexo_nome && !file && (
          <p className="mt-1 text-xs text-brand-400">Anexo atual: {andamento.anexo_nome}</p>
        )}
      </Field>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-60"
        >
          {saving ? "Salvando..." : "Salvar andamento"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-brand-200 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-white"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
