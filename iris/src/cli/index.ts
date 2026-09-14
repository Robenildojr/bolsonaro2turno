#!/usr/bin/env node
/**
 * Linha de comando.
 *
 * Tudo que dá para fazer conversando também dá para fazer daqui — e algumas
 * coisas só daqui, de propósito: guardar credencial (para o valor não passar
 * pela conversa), revogar autorização e o botão de pânico.
 */
import 'dotenv/config';
import { loadConfig, paths, saveConfig } from '../config.js';
import { configureLogger, describeError } from '../util/logger.js';
import { getKeyring } from '../core/crypto/keyring.js';
import { openStore, closeStore, getStore } from '../core/db/database.js';
import { initVault, getVault } from '../core/vault/vault.js';
import { initAudit, getAudit } from '../core/permissions/audit.js';
import { initBroker, getBroker } from '../core/permissions/broker.js';
import { initMemory, getMemory } from '../core/memory/index.js';
import { CAPABILITIES } from '../core/permissions/capabilities.js';
import { MEMORY_KINDS, type MemoryKind } from '../core/memory/types.js';
import { ask, askSecret, confirm } from '../util/prompt.js';
import { formatShort } from '../util/time.js';
import { runSetup, isInstalled } from './setup.js';

const AJUDA = `
Íris — agente pessoal

  iris setup                          instalação (senha-mestra, banco, autorizações)
  iris status                         estado geral do sistema
  iris conversar "texto"               uma pergunta pelo terminal

  iris memoria listar [tipo]          lista o que ela lembra
  iris memoria buscar "termo"         busca na memória
  iris memoria esquecer <id>          apaga uma memória
  iris memoria consolidar             roda agora a rotina noturna
  iris memoria reindexar              recalcula os embeddings

  iris permissoes                     lista autorizações
  iris permissoes conceder <cap> <escopo>
  iris permissoes revogar <id>
  iris permissoes revogar-tudo
  iris permissoes capacidades         lista o catálogo

  iris cofre listar                   credenciais guardadas (sem valores)
  iris cofre set <nome>               guarda uma credencial (pergunta no terminal)
  iris cofre remover <nome>

  iris auditoria [--hoje] [--limite N] [--acao prefixo]
  iris senha                          troca a senha-mestra
  iris panico                         revoga tudo e tranca as chaves
  iris manutencao                     compacta o banco e limpa vencidos
`;

async function main(): Promise<void> {
  const [, , comando = 'ajuda', ...args] = process.argv;

  if (comando === 'ajuda' || comando === '--help' || comando === '-h') {
    console.log(AJUDA);
    return;
  }

  if (comando === 'setup') {
    await runSetup();
    return;
  }

  if (!isInstalled()) {
    console.error('\n  A Íris ainda não foi instalada neste perfil. Rode: npm run setup\n');
    process.exit(1);
  }

  const cfg = loadConfig();
  configureLogger({ level: 'warn', dir: null }); // CLI fala com o usuário, não com o log

  const keyring = getKeyring(paths(cfg).keyring);
  keyring.unlock(process.env.IRIS_PASSPHRASE ?? (await askSecret('Senha-mestra: ')));

  const store = openStore(paths(cfg).db, keyring);
  initVault(store, keyring);
  const audit = initAudit(store);
  const broker = initBroker(store, audit, cfg);
  initMemory(store, cfg);

  try {
    await dispatch(comando, args);
  } finally {
    broker.shutdown();
    keyring.lock();
    closeStore();
  }
}

async function dispatch(comando: string, args: string[]): Promise<void> {
  const cfg = loadConfig();
  const quando = (ts: number | null | undefined) =>
    ts ? formatShort(new Date(ts), cfg.timezone, cfg.locale) : '—';

  switch (comando) {
    case 'status': {
      const stats = { ...getMemory().stats() };
      const banco = getStore().stats();
      console.log(`\n  ${cfg.assistantName} — estado\n`);
      console.log(`  Pasta:        ${paths(cfg).home}`);
      console.log(`  Banco:        ${(banco.arquivo_bytes! / 1024 ** 2).toFixed(1)} MB`);
      console.log(`  Modelo:       ${cfg.model.main} (esforço ${cfg.model.effort})`);
      console.log(`  Embeddings:   ${cfg.memory.embeddings}`);
      console.log(`  Conversas:    ${banco.conversations} (${banco.messages} mensagens)`);
      console.log(
        `  Memórias:     ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ') || 'nenhuma'}`,
      );
      console.log(`  Cofre:        ${banco.vault_items} credencial(is)`);
      console.log(`  Autorizações: ${getBroker().list().length}`);
      console.log(`  Observador:   ${cfg.observer.enabled ? 'LIGADO' : 'desligado'}`);
      console.log(
        `\n  Interface:    http://${cfg.server.host}:${cfg.server.port}/?token=${cfg.server.accessToken ?? ''}\n`,
      );
      return;
    }

    case 'conversar': {
      const texto = args.join(' ').trim();
      if (!texto) return console.log('  Use: iris conversar "sua pergunta"');
      const { initAgent } = await import('../core/agent/agent.js');
      const { registerCoreTools } = await import('../tools/index.js');
      const { bus } = await import('../core/events/bus.js');

      registerCoreTools();
      const agent = initAgent(getMemory(), cfg);

      // Sem interface, quem pergunta as autorizações é o próprio terminal.
      getBroker().setFallbackPrompt(async (req, risk) => {
        console.log(`\n  ── autorização (${risk}) ──`);
        console.log(`  ${req.reason}`);
        console.log(`  capacidade: ${req.capability}  escopo: ${req.scope}`);
        const resposta = await ask('  [a]gora / [s]empre / [t]udo nesta capacidade / [n]ão: ');
        const escolha = resposta.trim().toLowerCase()[0];
        if (escolha === 'a') return 'uma_vez';
        if (escolha === 's') return 'sempre';
        if (escolha === 't') return 'categoria';
        return 'negado';
      });

      bus.on('agent:delta', (e) => {
        process.stdout.write(e.text);
      });
      bus.on('tool:start', (e) => {
        process.stdout.write(`\n  [${e.tool}] ${e.summary}\n`);
      });

      const conv = getMemory().conversations.current('cli');
      process.stdout.write('\n');
      const r = await agent.run({ conversationId: conv.id, channel: 'cli', text: texto });
      if (!r.text) process.stdout.write('(sem resposta)');
      process.stdout.write('\n\n');
      return;
    }

    case 'memoria':
      return memoriaCmd(args, quando);

    case 'permissoes':
    case 'permissões':
      return permissoesCmd(args, quando);

    case 'cofre':
      return cofreCmd(args, quando);

    case 'auditoria': {
      const hoje = args.includes('--hoje');
      const limiteIdx = args.indexOf('--limite');
      const acaoIdx = args.indexOf('--acao');
      const entradas = getAudit().list({
        ...(hoje ? { since: startOfDay() } : {}),
        limit: limiteIdx >= 0 ? Number(args[limiteIdx + 1]) || 60 : 60,
        ...(acaoIdx >= 0 && args[acaoIdx + 1] ? { action: args[acaoIdx + 1]! } : {}),
      });
      if (entradas.length === 0) return console.log('\n  Nada registrado nesse período.\n');
      console.log('');
      for (const e of entradas.reverse()) {
        const marca = e.ok ? '✓' : '✗';
        const escopo = e.scope ? ` · ${e.scope}` : '';
        const ms = e.durationMs ? ` (${e.durationMs}ms)` : '';
        console.log(`  ${marca} ${quando(e.at)}  ${e.action}${escopo}${ms}`);
        const detalhe = JSON.stringify(e.detail);
        if (detalhe.length > 2) console.log(`      ${detalhe.slice(0, 180)}`);
      }
      console.log('');
      return;
    }

    case 'senha': {
      const atual = await askSecret('  Senha atual: ');
      const nova = await askSecret('  Nova senha: ');
      const conf = await askSecret('  Repita a nova: ');
      if (nova !== conf) throw new Error('as senhas não conferem');
      getKeyring().changePassphrase(atual, nova);
      console.log('\n  ✓ Senha trocada. Nenhum dado precisou ser recriptografado.\n');
      return;
    }

    case 'panico':
    case 'pânico': {
      const n = getBroker().revokeAll();
      saveConfig({ observer: { enabled: false, clipboard: false, activeWindow: false } });
      getAudit().record({ action: 'sistema.panico', detail: { autorizacoes_revogadas: n } });
      console.log(`\n  ✓ ${n} autorização(ões) revogada(s).`);
      console.log('  ✓ Observador desligado.');
      console.log('  ✓ Chaves apagadas da memória ao sair.');
      console.log('\n  Nada volta a funcionar sem a senha-mestra.\n');
      return;
    }

    case 'manutencao':
    case 'manutenção': {
      console.log('  Compactando o banco…');
      getStore().maintenance();
      const removidas = getAudit().prune(365);
      console.log(`  ✓ Pronto. ${removidas} registro(s) de auditoria com mais de um ano removidos.\n`);
      return;
    }

    default:
      console.log(`\n  Comando desconhecido: ${comando}`);
      console.log(AJUDA);
  }
}

// ── subcomandos ──────────────────────────────────────────────────────────────

async function memoriaCmd(args: string[], quando: (ts: number | null) => string): Promise<void> {
  const [sub = 'listar', ...rest] = args;
  const memory = getMemory();

  switch (sub) {
    case 'listar': {
      const tipo = rest[0] as MemoryKind | undefined;
      if (tipo && !MEMORY_KINDS.includes(tipo)) {
        return console.log(`  Tipo inválido. Opções: ${MEMORY_KINDS.join(', ')}`);
      }
      const itens = memory.list({ ...(tipo ? { kind: tipo } : {}), limit: 50 });
      if (itens.length === 0) return console.log('\n  Nada na memória ainda.\n');
      console.log('');
      for (const m of itens) {
        const marca = m.pinned ? '📌' : '  ';
        console.log(`  ${marca} [${m.id}] ${m.kind} · imp ${m.importance.toFixed(2)} · ${quando(m.updatedAt)}`);
        console.log(`      ${m.subject}: ${m.content.slice(0, 160)}`);
      }
      console.log(`\n  ${itens.length} memória(s).\n`);
      return;
    }

    case 'buscar': {
      const termo = rest.join(' ');
      if (!termo) return console.log('  Use: iris memoria buscar "termo"');
      const r = await memory.recall(termo, { limit: 20 });
      if (r.length === 0) return console.log('\n  Nada encontrado.\n');
      console.log('');
      for (const m of r) {
        console.log(`  [${m.id}] ${m.kind} · relevância ${m.score.toFixed(3)}`);
        console.log(`      ${m.subject}: ${m.content.slice(0, 200)}`);
      }
      console.log('');
      return;
    }

    case 'esquecer': {
      const id = rest[0];
      if (!id) return console.log('  Use: iris memoria esquecer <id>');
      const existente = memory.get(id);
      if (!existente) return console.log(`  Não achei ${id}.`);
      console.log(`  "${existente.subject}: ${existente.content.slice(0, 120)}"`);
      if (!(await confirm('  Apagar de vez?', false))) return console.log('  Cancelado.');
      memory.forget(id);
      console.log('  ✓ Apagada.\n');
      return;
    }

    case 'consolidar': {
      console.log('  Rodando a consolidação (isso usa a API e pode demorar)…\n');
      const r = await memory.consolidate();
      console.log(`  Envelhecidas: ${r.decayed}`);
      console.log(`  Fundidas:     ${r.merged}`);
      console.log(`  Resumidas:    ${r.summarized}`);
      console.log(`  Padrões:      ${r.insights}`);
      console.log(`  Perfil:       ${r.profileUpdated ? 'atualizado' : 'sem mudança'}`);
      console.log(`  Tempo:        ${(r.durationMs / 1000).toFixed(1)}s\n`);
      return;
    }

    case 'reindexar': {
      const n = await memory.reindex();
      console.log(`\n  ✓ ${n} memória(s) reindexada(s).\n`);
      return;
    }

    case 'perfil': {
      const perfil = memory.profile();
      console.log(perfil ? `\n${perfil}\n` : '\n  O perfil ainda não foi montado — ele nasce na consolidação.\n');
      return;
    }

    default:
      console.log('  Subcomandos: listar, buscar, esquecer, consolidar, reindexar, perfil');
  }
}

async function permissoesCmd(args: string[], quando: (ts: number | null) => string): Promise<void> {
  const [sub = 'listar', ...rest] = args;
  const broker = getBroker();

  switch (sub) {
    case 'listar': {
      const grants = broker.list();
      if (grants.length === 0) {
        return console.log('\n  Nenhuma autorização gravada. Ela vai perguntar em cada ação.\n');
      }
      console.log('');
      for (const g of grants) {
        const marca = g.decision === 'negado_sempre' ? '✗' : '✓';
        console.log(`  ${marca} [${g.id}] ${g.capability} em ${g.scope}`);
        console.log(
          `      risco ${g.risk} · usada ${g.useCount}× · última ${quando(g.lastUsedAt)} · desde ${quando(g.grantedAt)}`,
        );
        if (g.note) console.log(`      "${g.note}"`);
      }
      console.log('');
      return;
    }

    case 'conceder': {
      const [cap, escopo] = rest;
      if (!cap || !escopo) return console.log('  Use: iris permissoes conceder <capacidade> <escopo>');
      if (!CAPABILITIES[cap]) {
        return console.log(`  Capacidade desconhecida. Veja: iris permissoes capacidades`);
      }
      broker.grant(cap, escopo, 'concedido pela linha de comando');
      console.log(`\n  ✓ ${cap} liberado em ${escopo}. Ela não vai mais perguntar.\n`);
      return;
    }

    case 'negar': {
      const [cap, escopo] = rest;
      if (!cap || !escopo) return console.log('  Use: iris permissoes negar <capacidade> <escopo>');
      broker.deny(cap, escopo, 'negado pela linha de comando');
      console.log(`\n  ✓ ${cap} negado em ${escopo}. Ela nem vai perguntar.\n`);
      return;
    }

    case 'revogar': {
      const id = rest[0];
      if (!id) return console.log('  Use: iris permissoes revogar <id>');
      console.log(broker.revoke(id) ? '\n  ✓ Revogada.\n' : `\n  Não achei ${id}.\n`);
      return;
    }

    case 'revogar-tudo': {
      if (!(await confirm('\n  Revogar TODAS as autorizações?', false))) return console.log('  Cancelado.');
      console.log(`\n  ✓ ${broker.revokeAll()} revogada(s).\n`);
      return;
    }

    case 'capacidades': {
      console.log('');
      for (const spec of Object.values(CAPABILITIES)) {
        console.log(`  ${spec.id.padEnd(22)} risco ${spec.risk.padEnd(8)} escopo: ${spec.scopeKind}`);
        console.log(`      ${spec.explain}`);
      }
      console.log('');
      return;
    }

    default:
      console.log('  Subcomandos: listar, conceder, negar, revogar, revogar-tudo, capacidades');
  }
}

async function cofreCmd(args: string[], quando: (ts: number | null) => string): Promise<void> {
  const [sub = 'listar', ...rest] = args;
  const vault = getVault();

  switch (sub) {
    case 'listar': {
      const itens = vault.list();
      if (itens.length === 0) return console.log('\n  Cofre vazio.\n');
      console.log('');
      for (const i of itens) {
        console.log(`  {{cofre:${i.name}}}`);
        const detalhe = [i.meta.service, i.meta.username, i.meta.description].filter(Boolean).join(' · ');
        if (detalhe) console.log(`      ${detalhe}`);
        console.log(`      usada ${i.useCount}× · última ${quando(i.lastUsedAt)}`);
      }
      console.log('');
      return;
    }

    case 'set': {
      const nome = rest[0];
      if (!nome) return console.log('  Use: iris cofre set <nome>');
      const valor = await askSecret(`  Valor de "${nome}" (não aparece na tela): `);
      if (!valor) return console.log('  Cancelado: valor vazio.');
      const servico = await ask('  Serviço (ex.: pje.trt8.jus.br): ');
      const usuario = await ask('  Usuário (opcional): ');
      const descricao = await ask('  Para que serve: ');
      vault.set(nome, valor, {
        meta: { service: servico, username: usuario, description: descricao },
      });
      console.log(`\n  ✓ Guardado. Use como {{cofre:${nome}}} — o valor nunca passa pela conversa.\n`);
      return;
    }

    case 'remover': {
      const nome = rest[0];
      if (!nome) return console.log('  Use: iris cofre remover <nome>');
      console.log(vault.delete(nome) ? '\n  ✓ Removida.\n' : `\n  Não achei "${nome}".\n`);
      return;
    }

    default:
      console.log('  Subcomandos: listar, set, remover');
  }
}

// ── auxiliares ───────────────────────────────────────────────────────────────

function startOfDay(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

main().catch((err) => {
  console.error(`\n  ${describeError(err)}\n`);
  process.exit(1);
});
