import type { ReactNode } from "react";
import type { ProcessoStatus } from "../types";
import { STATUS_LABELS } from "../types";

export function Banner({ kind, children }: { kind: "success" | "error"; children: ReactNode }) {
  const styles =
    kind === "success" ? "bg-green-50 text-green-700 border-green-200" : "bg-red-50 text-red-700 border-red-200";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${styles}`} role="alert">
      {children}
    </div>
  );
}

const STATUS_STYLES: Record<ProcessoStatus, string> = {
  ativo: "bg-green-100 text-green-800",
  suspenso: "bg-amber-100 text-amber-800",
  arquivado: "bg-brand-100 text-brand-600",
  encerrado: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: ProcessoStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight text-brand-800 md:text-2xl">{title}</h1>
      {actions}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-brand-200 bg-white shadow-sm ${className}`}>{children}</div>;
}

export function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-brand-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      {children}
    </label>
  );
}
