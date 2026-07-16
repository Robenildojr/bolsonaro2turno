import { supabase } from "../lib/supabaseClient";

const BUCKET = "anexos";

export async function uploadAnexo(processoId: string, file: File): Promise<{ path: string; nome: string }> {
  const path = `${processoId}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file);
  if (error) throw error;
  return { path, nome: file.name };
}

export async function getAnexoSignedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 5);
  if (error) return null;
  return data.signedUrl;
}

export async function removeProcessoAnexos(processoId: string): Promise<void> {
  const { data } = await supabase.storage.from(BUCKET).list(processoId);
  if (!data || data.length === 0) return;
  await supabase.storage.from(BUCKET).remove(data.map((f) => `${processoId}/${f.name}`));
}

export async function removeAnexo(path: string): Promise<void> {
  await supabase.storage.from(BUCKET).remove([path]);
}
