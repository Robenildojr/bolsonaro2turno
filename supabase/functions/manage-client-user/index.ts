// Supabase Edge Function: manage-client-user
//
// Provisions / updates / removes the Auth account tied to a `cliente` record.
// Client portal login is the CPF (digits only); the initial password is the
// same CPF. Since Supabase Auth identities require an email, the CPF is
// mapped to a deterministic synthetic address (see `cpfToEmail`) that is
// never shown to the user — the login screen only ever asks for the CPF.
//
// This must run with the service role key (`auth.admin.*` calls are not
// available with the anon/public key), so it is invoked from the browser via
// `supabase.functions.invoke(...)`, authenticated as the logged-in admin. The
// function re-checks that the caller is really an admin before doing anything.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function cpfToEmail(cpf: string): string {
  const digits = cpf.replace(/\D/g, "");
  return `cpf.${digits}@clientes.portaljuridico.local`;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

type Payload = {
  action: "create" | "update" | "delete";
  clienteId: string;
  cpf?: string;
  nome?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return json({ error: "missing authorization" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: callerData, error: callerErr } = await asCaller.auth.getUser();
  if (callerErr || !callerData?.user) return json({ error: "invalid session" }, 401);

  const { data: callerProfile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (callerProfile?.role !== "admin") {
    return json({ error: "forbidden: admin role required" }, 403);
  }

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { action, clienteId } = payload;
  if (!action || !clienteId) return json({ error: "action and clienteId are required" }, 400);

  try {
    if (action === "create") {
      const cpf = (payload.cpf ?? "").replace(/\D/g, "");
      if (cpf.length !== 11) return json({ error: "cpf must have 11 digits" }, 400);

      const email = cpfToEmail(cpf);
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: cpf,
        email_confirm: true,
        user_metadata: { nome: payload.nome ?? null, cpf },
      });
      if (createErr) return json({ error: createErr.message }, 400);

      const { error: profileErr } = await admin.from("profiles").insert({
        id: created.user.id,
        role: "cliente",
        cliente_id: clienteId,
        must_change_password: true,
      });
      if (profileErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: profileErr.message }, 400);
      }

      return json({ ok: true, userId: created.user.id });
    }

    if (action === "update") {
      const { data: profile, error: findErr } = await admin
        .from("profiles")
        .select("id")
        .eq("cliente_id", clienteId)
        .eq("role", "cliente")
        .maybeSingle();
      if (findErr) return json({ error: findErr.message }, 400);
      if (!profile) return json({ error: "client account not found" }, 404);

      if (payload.cpf) {
        const cpf = payload.cpf.replace(/\D/g, "");
        if (cpf.length !== 11) return json({ error: "cpf must have 11 digits" }, 400);
        const { error: updErr } = await admin.auth.admin.updateUserById(profile.id, {
          email: cpfToEmail(cpf),
          user_metadata: { nome: payload.nome ?? null, cpf },
        });
        if (updErr) return json({ error: updErr.message }, 400);
      }

      return json({ ok: true, userId: profile.id });
    }

    if (action === "delete") {
      const { data: profile } = await admin
        .from("profiles")
        .select("id")
        .eq("cliente_id", clienteId)
        .eq("role", "cliente")
        .maybeSingle();

      if (profile) {
        await admin.auth.admin.deleteUser(profile.id);
      }
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (err) {
    return json({ error: (err as Error).message ?? "unexpected error" }, 500);
  }
});
