# Portal Jurídico

Sistema de gestão para escritório de advocacia, com duas áreas:

- **Área do Administrador** — cadastro de clientes, processos e andamentos.
- **Portal do Cliente** — consulta, somente leitura, dos próprios processos e da linha do tempo de andamentos.

## Stack

- React + TypeScript + Vite, Tailwind CSS.
- Supabase (Postgres + Auth + Storage) com Row Level Security para isolar os dados de cada cliente.

## Como rodar localmente

```bash
npm install
cp .env.example .env   # preencha com a URL e a anon key do seu projeto Supabase
npm run dev
```

Antes de logar, configure o banco: siga `supabase/README.md` para aplicar as
migrations, publicar a edge function `manage-client-user` e criar o primeiro
usuário administrador.

## Login

- **Administrador**: e-mail e senha (conta criada manualmente no Supabase Auth).
- **Cliente**: CPF (somente números) como login; a senha inicial também é o
  CPF. No primeiro acesso o cliente é obrigado a trocar a senha.

O acesso do cliente ao portal é criado automaticamente quando o administrador
cadastra o cliente — não é preciso nenhum passo manual.

## Isolamento de dados

Todo o isolamento entre clientes é garantido por Row Level Security no
Postgres (ver `supabase/migrations/0001_init.sql`): um cliente autenticado só
enxerga, via políticas de RLS, os próprios registros em `clientes`,
`processos`, `andamentos` e nos anexos do Storage — nunca dados de outro
cliente, mesmo que a query tente burlar isso no front-end.

## Scripts

- `npm run dev` — servidor de desenvolvimento.
- `npm run build` — checagem de tipos + build de produção.
- `npm run lint` — lint com oxlint.
