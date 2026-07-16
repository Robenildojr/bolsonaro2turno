import { useState } from "react";
import { getAnexoSignedUrl } from "../utils/storage";

export function AnexoLink({ path, nome }: { path: string; nome: string | null }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    const url = await getAnexoSignedUrl(path);
    setLoading(false);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-md border border-brand-200 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
    >
      📎 {loading ? "Abrindo..." : (nome ?? "Baixar anexo")}
    </button>
  );
}
