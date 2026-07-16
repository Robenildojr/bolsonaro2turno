# Supabase setup

1. Create a Supabase project.
2. Apply the schema: run `supabase/migrations/0001_init.sql` in the SQL editor
   (or `supabase db push` if you use the Supabase CLI with this repo linked).
3. Deploy the edge function used to provision client logins:
   ```
   supabase functions deploy manage-client-user
   ```
   It needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
   available as function secrets — on hosted Supabase these are already
   injected automatically for every edge function.
4. Create the first administrator manually (Authentication → Add user, with a
   real e-mail and password), then give it the admin role:
   ```sql
   insert into public.profiles (id, role, must_change_password)
   values ('<auth-user-uuid>', 'admin', false);
   ```
5. Copy `.env.example` to `.env` in the project root and fill in
   `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` from Project Settings → API.

## How client login works

Clients never see or type an e-mail. The portal login form asks only for CPF
+ password. Under the hood, the CPF is mapped to a deterministic, internal
address (`cpf.<11 digits>@clientes.portaljuridico.local`) which is what is
actually stored in `auth.users`. The `manage-client-user` edge function is
the only place allowed to create/update/delete those accounts, using the
service role key — this keeps that privileged key out of the browser bundle.
