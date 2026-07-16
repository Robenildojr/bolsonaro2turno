-- Portal Jurídico — schema, RLS and helper functions
-- Run this against a Supabase Postgres project (SQL editor or `supabase db push`).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cpf text not null unique,
  email text,
  telefone text,
  endereco text,
  observacoes text,
  created_at timestamptz not null default now()
);

comment on column public.clientes.cpf is 'CPF digits only (11 chars), used as portal login.';

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'cliente' check (role in ('admin', 'cliente')),
  cliente_id uuid references public.clientes (id) on delete cascade,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  constraint profiles_cliente_role_chk check (
    (role = 'cliente' and cliente_id is not null) or
    (role = 'admin' and cliente_id is null)
  )
);

create table if not exists public.processos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes (id) on delete cascade,
  numero_cnj text not null,
  tipo_acao text,
  vara text,
  comarca text,
  parte_contraria text,
  valor_causa numeric(14, 2),
  status text not null default 'ativo' check (status in ('ativo', 'suspenso', 'arquivado', 'encerrado')),
  data_distribuicao date,
  observacoes text,
  created_at timestamptz not null default now()
);

create table if not exists public.andamentos (
  id uuid primary key default gen_random_uuid(),
  processo_id uuid not null references public.processos (id) on delete cascade,
  data date not null default current_date,
  titulo text not null,
  descricao text,
  anexo_url text,
  anexo_nome text,
  created_at timestamptz not null default now()
);

create index if not exists idx_clientes_cpf on public.clientes (cpf);
create index if not exists idx_processos_cliente_id on public.processos (cliente_id);
create index if not exists idx_processos_numero_cnj on public.processos (numero_cnj);
create index if not exists idx_andamentos_processo_id on public.andamentos (processo_id);
create index if not exists idx_andamentos_data on public.andamentos (data desc);

-- ---------------------------------------------------------------------------
-- Helper functions (security definer, used inside RLS policies)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.my_cliente_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select cliente_id from public.profiles where id = auth.uid();
$$;

-- Prevent a client from escalating their own role/cliente_id via a direct
-- update to their profiles row (they are only ever allowed to flip
-- must_change_password off after a forced password change).
create or replace function public.prevent_profile_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role or new.cliente_id is distinct from old.cliente_id then
      raise exception 'not allowed to change role or cliente_id';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_profile_privilege_escalation on public.profiles;
create trigger trg_prevent_profile_privilege_escalation
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_escalation();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.clientes enable row level security;
alter table public.profiles enable row level security;
alter table public.processos enable row level security;
alter table public.andamentos enable row level security;

-- clientes: admin full access, client can read only their own record
drop policy if exists clientes_admin_all on public.clientes;
create policy clientes_admin_all on public.clientes
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists clientes_self_select on public.clientes;
create policy clientes_self_select on public.clientes
  for select using (id = public.my_cliente_id());

-- profiles: admin full access, user can read/update only their own row
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- processos: admin full access, client can read only their own processes
drop policy if exists processos_admin_all on public.processos;
create policy processos_admin_all on public.processos
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists processos_self_select on public.processos;
create policy processos_self_select on public.processos
  for select using (cliente_id = public.my_cliente_id());

-- andamentos: admin full access, client can read only andamentos of their own processes
drop policy if exists andamentos_admin_all on public.andamentos;
create policy andamentos_admin_all on public.andamentos
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists andamentos_self_select on public.andamentos;
create policy andamentos_self_select on public.andamentos
  for select using (
    processo_id in (
      select id from public.processos where cliente_id = public.my_cliente_id()
    )
  );

-- ---------------------------------------------------------------------------
-- Storage bucket for andamento attachments
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('anexos', 'anexos', false)
on conflict (id) do nothing;

-- Objects are stored as `${processo_id}/${filename}`. A client may only
-- download attachments that belong to one of their own processes.
drop policy if exists anexos_admin_all on storage.objects;
create policy anexos_admin_all on storage.objects
  for all using (bucket_id = 'anexos' and public.is_admin())
  with check (bucket_id = 'anexos' and public.is_admin());

drop policy if exists anexos_self_select on storage.objects;
create policy anexos_self_select on storage.objects
  for select using (
    bucket_id = 'anexos'
    and (storage.foldername(name))[1]::uuid in (
      select id from public.processos where cliente_id = public.my_cliente_id()
    )
  );
