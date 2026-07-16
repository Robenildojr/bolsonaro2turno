import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { Banner, Card, Field, PageHeader } from "../../components/ui";
import { isValidCpf, maskCpf, onlyDigits } from "../../utils/cpf";

export default function ClienteForm() {
  const { id } = useParams();
  const isEditing = Boolean(id);
  const navigate = useNavigate();

  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [email, setEmail] = useState("");
  const [telefone, setTelefone] = useState("");
  const [endereco, setEndereco] = useState("");
  const [observacoes, setObservacoes] = useState("");
  const [originalCpf, setOriginalCpf] = useState("");

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    async function load() {
      const { data, error: fetchError } = await supabase.from("clientes").select("*").eq("id", id).single();
      if (fetchError) {
        setError(fetchError.message);
      } else if (data) {
        setNome(data.nome);
        setCpf(maskCpf(data.cpf));
        setOriginalCpf(data.cpf);
        setEmail(data.email ?? "");
        setTelefone(data.telefone ?? "");
        setEndereco(data.endereco ?? "");
        setObservacoes(data.observacoes ?? "");
      }
      setLoading(false);
    }
    load();
  }, [id]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!isValidCpf(cpf)) {
      setError("CPF inválido. Confira os números digitados.");
      return;
    }

    setSaving(true);
    const cpfDigits = onlyDigits(cpf);
    const payload = {
      nome,
      cpf: cpfDigits,
      email: email || null,
      telefone: telefone || null,
      endereco: endereco || null,
      observacoes: observacoes || null,
    };

    if (isEditing) {
      const { error: updateError } = await supabase.from("clientes").update(payload).eq("id", id);
      if (updateError) {
        setSaving(false);
        setError(updateError.message);
        return;
      }
      if (cpfDigits !== originalCpf) {
        const { error: fnError } = await supabase.functions.invoke("manage-client-user", {
          body: { action: "update", clienteId: id, cpf: cpfDigits, nome },
        });
        if (fnError) {
          setSaving(false);
          setError("Cliente atualizado, mas houve um erro ao atualizar o login de acesso: " + fnError.message);
          return;
        }
      }
      setSaving(false);
      setSuccess("Cliente atualizado com sucesso.");
      return;
    }

    const { data: created, error: insertError } = await supabase.from("clientes").insert(payload).select().single();
    if (insertError) {
      setSaving(false);
      setError(insertError.message);
      return;
    }

    const { error: fnError } = await supabase.functions.invoke("manage-client-user", {
      body: { action: "create", clienteId: created.id, cpf: cpfDigits, nome },
    });
    setSaving(false);
    if (fnError) {
      setError(
        "Cliente cadastrado, mas houve um erro ao criar o acesso ao portal: " +
          fnError.message +
          ". Você pode editar o cliente para tentar novamente.",
      );
      return;
    }

    navigate("/admin/clientes", {
      state: { message: `Cliente "${nome}" cadastrado. Acesso ao portal: login e senha = CPF (${maskCpf(cpfDigits)}).` },
    });
  }

  if (loading) return <div className="p-6 text-sm text-brand-400">Carregando...</div>;

  return (
    <div>
      <PageHeader title={isEditing ? "Editar cliente" : "Novo cliente"} />

      <Card className="max-w-2xl p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Nome completo" required>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              required
              className="input"
            />
          </Field>

          <Field label="CPF" required>
            <input
              value={cpf}
              onChange={(e) => setCpf(maskCpf(e.target.value))}
              inputMode="numeric"
              maxLength={14}
              placeholder="000.000.000-00"
              required
              className="input"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="E-mail">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" />
            </Field>
            <Field label="Telefone/WhatsApp">
              <input value={telefone} onChange={(e) => setTelefone(e.target.value)} className="input" />
            </Field>
          </div>

          <Field label="Endereço">
            <input value={endereco} onChange={(e) => setEndereco(e.target.value)} className="input" />
          </Field>

          <Field label="Observações">
            <textarea
              value={observacoes}
              onChange={(e) => setObservacoes(e.target.value)}
              rows={3}
              className="input"
            />
          </Field>

          {isEditing && (
            <p className="text-xs text-brand-400">
              Alterar o CPF atualiza automaticamente o login de acesso do cliente ao portal.
            </p>
          )}
          {!isEditing && (
            <p className="text-xs text-brand-400">
              O acesso ao portal será criado automaticamente: login e senha iniciais = CPF do cliente.
            </p>
          )}

          {error && <Banner kind="error">{error}</Banner>}
          {success && <Banner kind="success">{success}</Banner>}

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
              onClick={() => navigate("/admin/clientes")}
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
