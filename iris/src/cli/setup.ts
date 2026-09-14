/**
 * Assistente de instalação.
 *
 * Roda uma vez. Cria a senha-mestra, o chaveiro, o banco e o token de acesso, e
 * pergunta o mínimo necessário para a Íris já servir para alguma coisa no
 * primeiro uso. O resto se configura conversando com ela depois.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths, saveConfig } from '../config.js';
import { assertPassphraseStrength, Keyring } from '../core/crypto/keyring.js';
import { randomToken } from '../core/crypto/cipher.js';
import { openStore } from '../core/db/database.js';
import { initVault } from '../core/vault/vault.js';
import { initAudit } from '../core/permissions/audit.js';
import { initBroker } from '../core/permissions/broker.js';
import { ask, askSecret, choose, confirm } from '../util/prompt.js';
import { describeError } from '../util/logger.js';

const linha = '─'.repeat(64);

export async function runSetup(): Promise<void> {
  const cfg = loadConfig();
  const p = paths(cfg);

  console.log(`\n${linha}\n  Instalação da Íris\n${linha}\n`);
  console.log(`  Pasta de dados: ${p.home}`);
  console.log('  Tudo fica nesta máquina. Nada é enviado sem você mandar.\n');

  // ── 1. senha-mestra ────────────────────────────────────────────────────────
  const keyring = new Keyring(p.keyring);
  if (keyring.exists()) {
    console.log('  Já existe um chaveiro aqui — a senha-mestra não será recriada.');
    const trocar = await confirm('  Quer trocar a senha-mestra agora?', false);
    if (trocar) {
      const atual = await askSecret('  Senha atual: ');
      const nova = await askSecret('  Nova senha: ');
      const conf = await askSecret('  Repita a nova senha: ');
      if (nova !== conf) throw new Error('as senhas não conferem');
      keyring.changePassphrase(atual, nova);
      console.log('  ✓ Senha trocada. Os dados antigos continuam legíveis.\n');
    }
    keyring.lock();
  } else {
    console.log('  A senha-mestra protege TODA a memória, o cofre e o backup.');
    console.log('  Ela não tem recuperação: se perder, os dados não voltam.');
    console.log('  Guarde-a num gerenciador de senhas antes de continuar.\n');

    let senha = '';
    for (;;) {
      senha = await askSecret('  Crie a senha-mestra: ');
      try {
        assertPassphraseStrength(senha);
      } catch (err) {
        console.log(`  ✗ ${describeError(err)}\n`);
        continue;
      }
      const conf = await askSecret('  Repita a senha: ');
      if (senha !== conf) {
        console.log('  ✗ As senhas não conferem.\n');
        continue;
      }
      break;
    }
    keyring.create(senha);
    console.log('  ✓ Chaveiro criado.\n');
  }

  // ── 2. identidade ──────────────────────────────────────────────────────────
  const nome = await ask(`  Como você quer ser chamado? [${cfg.ownerName}] `);
  const assistente = await ask(`  E o nome dela? [${cfg.assistantName}] `);
  const fuso = await ask(`  Seu fuso horário? [${cfg.timezone}] `);

  // ── 3. chave da API ────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n  A chave da API da Anthropic não está no ambiente.');
    console.log('  Pegue em console.anthropic.com e coloque no arquivo .env como:');
    console.log('    ANTHROPIC_API_KEY=sk-ant-...\n');
  } else {
    console.log('\n  ✓ Chave da API encontrada no ambiente.');
  }

  // ── 4. embeddings ──────────────────────────────────────────────────────────
  const escolhaEmb = await choose('\n  Como indexar a memória para busca?', [
    'Local — nada sai da sua máquina, funciona offline (recomendado)',
    'Voyage AI — mais preciso em paráfrase, mas envia o texto para fora',
  ]);

  // ── 5. token de acesso ─────────────────────────────────────────────────────
  const token = cfg.server.accessToken || randomToken(24);

  saveConfig({
    ownerName: nome || cfg.ownerName,
    assistantName: assistente || cfg.assistantName,
    timezone: fuso || cfg.timezone,
    memory: { embeddings: escolhaEmb === 1 ? 'voyage' : 'local' },
    server: { accessToken: token },
  });

  // ── 6. banco ───────────────────────────────────────────────────────────────
  const senhaParaAbrir = keyring.unlocked ? null : await askSecret('  Confirme a senha-mestra: ');
  if (senhaParaAbrir) keyring.unlock(senhaParaAbrir);

  const store = openStore(p.db, keyring);
  initVault(store, keyring);
  const broker = initBroker(store, initAudit(store), loadConfig({ reload: true }));

  // ── 7. primeiras autorizações ──────────────────────────────────────────────
  console.log(`\n${linha}\n  Primeiras autorizações\n${linha}\n`);
  console.log('  Você pode liberar tudo aos poucos, conforme for usando. O que');
  console.log('  não for liberado agora, ela pede na hora — e uma vez que você');
  console.log('  responder "sempre", não pergunta de novo.\n');

  const pastaTrabalho = await ask(
    '  Qual pasta ela pode ler e escrever livremente? (vazio = nenhuma por enquanto)\n  Ex.: ~/Documentos/processos\n  > ',
  );
  if (pastaTrabalho.trim()) {
    const alvo = expand(pastaTrabalho.trim());
    const escopo = alvo.endsWith('/**') ? alvo : path.join(alvo, '**');
    broker.grant('arquivo.ler', escopo, 'pasta de trabalho definida na instalação');
    broker.grant('arquivo.escrever', escopo, 'pasta de trabalho definida na instalação');
    console.log(`  ✓ Liberado ler e escrever em ${escopo}`);
  }

  if (await confirm('\n  Liberar consulta a páginas públicas da internet?', true)) {
    broker.grant('web.ler', '*', 'pesquisa na internet');
    broker.grant('processo.consultar', '*', 'consulta processual');
    console.log('  ✓ Liberado.');
  }

  if (await confirm('  Liberar ver informações do sistema (disco, memória, hora)?', true)) {
    broker.grant('sistema.info', '*', 'diagnóstico');
    console.log('  ✓ Liberado.');
  }

  if (await confirm('  Liberar a agenda (lembretes e tarefas)?', true)) {
    broker.grant('agenda.gravar', '*', 'agenda e lembretes');
    console.log('  ✓ Liberado.');
  }

  console.log('\n  O resto — terminal, navegador, e-mail, WhatsApp — fica para');
  console.log('  quando você precisar. Ela pede na hora, com contexto.\n');

  store.close();
  keyring.lock();

  const cfgFinal = loadConfig({ reload: true });
  console.log(`${linha}\n  Pronto\n${linha}\n`);
  console.log('  Suba com:   npm run build && npm start');
  console.log(`  Endereço:   http://${cfgFinal.server.host}:${cfgFinal.server.port}/?token=${token}`);
  console.log(`  Token:      ${token}`);
  console.log('\n  Guarde esse endereço. Ele está salvo em ~/.iris/config.json.\n');
}

function expand(p: string): string {
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  }
  return path.resolve(p);
}

/** Verifica se a instalação já foi feita. */
export function isInstalled(): boolean {
  return fs.existsSync(paths().keyring);
}
