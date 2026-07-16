import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Banner, Card, Field, PageHeader } from "../../components/ui";
import { maskCnj } from "../../utils/cnj";
import { STATUS_LABELS, type Cliente, type ProcessoStatus } from "../../types";

export default function ProcessoForm() {
  const { id } = useParams();
  const isEditing = Boolean(id);
  const navigate = useNavigate();

  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [numeroCnj, setNumeroCnj] = useState("");
  const [tipoAcao, setTipoAcao] = useState("");
  const [vara, setVara] = useState("");
  const [comarca, setComarca] = useState("");
  const [parteContraria, setParteContraria] = useState("");
  const [valorCausa, setValorCausa] = useState("");
  const [status, setStatus] = useState<ProcessoStatus>("ativo");
  const [dataDistribuicao, setDataDistribuicao] = useState("");
  const [observacoes, setObservacoes] = useState("");

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadClientes() {
      const { data } = await supabase.from("clientes").select("*").order("nome");
      setClientes(data ?? []);
    }
    loadClientes();
  }, []);

  useEffect(() => {
    if (!id) return;
    async function load() {
      const { data, error: fetchError } = await supabase.from("processos").select("*").eq("id", id).single();
      if (fetchError) {
        setError(fetchError.message);
      } else if (data) {
        setClienteId(data.cliente_id);
        setNumeroCnj(maskCnj(data.numero_cnj));
        setTipoAcao(data.tipo_acao ?? "");
        setVara(data.vara ?? "");
        setComarca(data.comarca ?? "");
        setParteContraria(data.parte_contraria ?? "");
        setValorCausa(data.valor_causa != null ? String(data.valor_causa) : "");
        setStatus(data.status);
        setDataDistribuicao(data.data_distribuicao ?? "");
        setObservacoes(data.observacoes ?? "");
      }
      setLoading(false);
    }
    load();
  }, [id]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!clienteId) {
      setError("Selecione o cliente vinculado ao processo.");
      return;
    }

    setSaving(true);
    const payload = {
      cliente_id: clienteId,
      numero_cnj: numeroCnj,
      tipo_acao: tipoAcao || null,
      vara: vara || null,
      comarca: comarca || null,
      parte_contraria: parteContraria || null,
      valor_causa: valorCausa ? Number(valorCausa) : null,
      status,
      data_distribuicao: dataDistribuicao || null,
      observacoes: observacoes || null,
    };

    const result = isEditing
      ? await supabase.from("processos").update(payload).eq("id", id)
      : await supabase.from("processos").insert(payload).select().single();

    setSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }

    const targetId = isEditing ? id : (result.data as { id: string }).id;
    navigate(`/admin/processos/${targetId}`, {
      state: { message: isEditing ? "Processo atualizado com sucesso." : "Processo cadastrado com sucesso." },
    });
  }

  if (loading) return <div className="p-6 text-sm text-brand-400">Carregando...</div>;

  return (
    <div>
      <PageHeader title={isEditing ? "Editar processo" : "Novo processo"} />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Cliente" required>
            <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} required className="input">
              <option value="">Selecione um cliente...</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Número do processo (CNJ)" required>
            <input
              value={numeroCnj}
              onChange={(e) => setNumeroCnj(maskCnj(e.target.value))}
              placeholder="0000000-00.0000.0.00.0000"
              maxLength={25}
              required
              className="input"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Tipo de ação">
              <input value={tipoAcao} onChange={(e) => setTipoAcao(e.target.value)} className="input" />
            </Field>
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as ProcessoStatus)} className="input">
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Vara">
              <input value={vara} onChange={(e) => setVara(e.target.value)} className="input" />
            </Field>
            <Field label="Comarca/Tribunal">
              <input value={comarca} onChange={(e) => setComarca(e.target.value)} className="input" />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Parte contrária">
              <input value={parteContraria} onChange={(e) => setParteContraria(e.target.value)} className="input" />
            </Field>
            <Field label="Valor da causa (R$)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={valorCausa}
                onChange={(e) => setValorCausa(e.target.value)}
                className="input"
              />
            </Field>
          </div>

          <Field label="Data de distribuição">
            <input
              type="date"
              value={dataDistribuicao}
              onChange={(e) => setDataDistribuicao(e.target.value)}
              className="input"
            />
          </Field>

          <Field label="Observações">
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={3}
              className="input"
            />
          </Field>

          {error && <Banner kind="error">{error}</Banner>}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-brand-700 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Salvando..." : "Salvar"}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-md border border-brand-200 px-5 py-2.5 text-sm font-medium text-brand-700 hover:bg-brand-100"
            >
              Cancelar
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
