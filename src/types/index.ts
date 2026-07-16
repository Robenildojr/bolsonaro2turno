export type Role = "admin" | "cliente";

export interface Profile {
  id: string;
  role: Role;
  cliente_id: string | null;
  must_change_password: boolean;
}

export interface Cliente {
  id: string;
  nome: string;
  cpf: string;
  email: string | null;
  telefone: string | null;
  endereco: string | null;
  observacoes: string | null;
  created_at: string;
}

export type ProcessoStatus = "ativo" | "suspenso" | "arquivado" | "encerrado";

export interface Processo {
  id: string;
  cliente_id: string;
  numero_cnj: string;
  tipo_acao: string | null;
  vara: string | null;
  comarca: string | null;
  parte_contraria: string | null;
  valor_causa: number | null;
  status: ProcessoStatus;
  data_distribuicao: string | null;
  observacoes: string | null;
  created_at: string;
}

export interface Andamento {
  id: string;
  processo_id: string;
  data: string;
  titulo: string;
  descricao: string | null;
  anexo_url: string | null;
  anexo_nome: string | null;
  created_at: string;
}

export const STATUS_LABELS: Record<ProcessoStatus, string> = {
  ativo: "Ativo",
  suspenso: "Suspenso",
  arquivado: "Arquivado",
  encerrado: "Encerrado",
};
