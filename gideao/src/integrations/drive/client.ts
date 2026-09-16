/**
 * Cliente do Google Drive, em REST puro.
 *
 * Sem a biblioteca `googleapis`: são quatro chamadas HTTP e a dependência
 * pesa dezenas de megabytes. Menos código de terceiro no caminho de um arquivo
 * que contém a sua vida inteira é uma escolha consciente.
 *
 * **Escopo `drive.file`**, e isso importa: esse escopo dá acesso apenas aos
 * arquivos que o próprio Gideão criou. Ele não consegue ler, listar ou apagar
 * mais nada do seu Drive, nem que quisesse. O Google impõe isso, não é uma
 * promessa do código.
 *
 * O fluxo de autorização é o de aplicativo instalado (loopback): abrimos um
 * servidor efêmero em 127.0.0.1, você autoriza no navegador e o código volta
 * direto para cá — sem passar por servidor de terceiro.
 */
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getVault } from '../../core/vault/vault.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('drive');

const ESCOPO = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface ArquivoDrive {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

export class DriveClient {
  private accessToken: string | null = null;
  private expiraEm = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  get configurado(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  get autorizado(): boolean {
    return Boolean(getVault().get('drive.refresh_token'));
  }

  /**
   * Autorização interativa. Abre o navegador (ou imprime a URL) e espera o
   * retorno no loopback. O refresh token vai para o cofre.
   */
  async autorizar(): Promise<void> {
    if (!this.configurado) {
      throw new Error(
        'faltam DRIVE_CLIENT_ID e DRIVE_CLIENT_SECRET. Crie credenciais do tipo ' +
          '"App para computador" em console.cloud.google.com → APIs e Serviços → Credenciais.',
      );
    }

    const estado = randomBytes(16).toString('hex');
    // PKCE: protege o código de autorização mesmo num redirecionamento local.
    const verificador = randomBytes(32).toString('base64url');
    const desafio = createHash('sha256').update(verificador).digest('base64url');

    const { codigo, redirectUri } = await this.receberCodigo(estado, verificador, desafio);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: codigo,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verificador,
      }),
    });

    if (!res.ok) {
      throw new Error(`o Google recusou a troca do código: ${(await res.text()).slice(0, 300)}`);
    }

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    if (!tokens.refresh_token) {
      throw new Error(
        'o Google não devolveu refresh token. Isso costuma acontecer quando a conta já ' +
          'autorizou antes: revogue em myaccount.google.com/permissions e tente de novo.',
      );
    }

    getVault().set('drive.refresh_token', tokens.refresh_token, {
      kind: 'token',
      meta: { service: 'drive.google.com', description: 'Backup cifrado da memória do Gideão' },
    });
    this.accessToken = tokens.access_token;
    this.expiraEm = Date.now() + (tokens.expires_in - 60) * 1000;
    log.info('Google Drive autorizado');
  }

  /** Sobe um servidor efêmero no loopback e espera o retorno do Google. */
  private receberCodigo(
    estado: string,
    _verificador: string,
    desafio: string,
  ): Promise<{ codigo: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let porta = 0;
      let redirectUri = '';

      const servidor = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/oauth') {
          res.writeHead(404).end();
          return;
        }

        const erro = url.searchParams.get('error');
        const codigo = url.searchParams.get('code');
        const estadoRecebido = url.searchParams.get('state');

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(erro || !codigo ? PAGINA_ERRO(erro ?? 'o Google não devolveu o código') : PAGINA_OK);
        servidor.close();

        if (erro || !codigo) return reject(new Error(erro ?? 'autorização cancelada'));
        if (estadoRecebido !== estado) {
          return reject(new Error('estado divergente — possível interferência no redirecionamento'));
        }
        resolve({ codigo, redirectUri });
      });

      // A porta só existe depois do listen, então a URL é montada aqui dentro.
      servidor.listen(0, '127.0.0.1', () => {
        porta = (servidor.address() as AddressInfo).port;
        redirectUri = `http://127.0.0.1:${porta}/oauth`;

        const url = new URL(AUTH_URL);
        url.searchParams.set('client_id', this.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', ESCOPO);
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('prompt', 'consent');
        url.searchParams.set('state', estado);
        url.searchParams.set('code_challenge', desafio);
        url.searchParams.set('code_challenge_method', 'S256');

        console.log('\n  Autorize o acesso ao Drive abrindo este endereço no navegador:\n');
        console.log(`  ${url.toString()}\n`);
        console.log('  Escopo pedido: apenas os arquivos que o Gideão criar. Nada mais do seu Drive.\n');
      });

      servidor.on('error', (err) => reject(err));

      const prazo = setTimeout(
        () => {
          servidor.close();
          reject(new Error('tempo esgotado esperando a autorização (5 min)'));
        },
        5 * 60_000,
      );
      servidor.on('close', () => clearTimeout(prazo));
    });
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiraEm) return this.accessToken;

    const refresh = getVault().get('drive.refresh_token');
    if (!refresh) throw new Error('o Drive ainda não foi autorizado. Rode: gideao backup autorizar');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refresh,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      throw new Error(
        `não consegui renovar o acesso ao Drive (${res.status}). ` +
          'Se você revogou a permissão, autorize de novo: gideao backup autorizar',
      );
    }

    const tokens = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = tokens.access_token;
    this.expiraEm = Date.now() + (tokens.expires_in - 60) * 1000;
    return this.accessToken;
  }

  /** Acha (ou cria) a pasta do Gideão. Devolve o id. */
  async pasta(nome: string): Promise<string> {
    const token = await this.token();
    const q = encodeURIComponent(
      `name = '${nome.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    );

    const busca = await fetch(`${API}/files?q=${q}&fields=files(id,name)&pageSize=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (busca.ok) {
      const json = (await busca.json()) as { files?: Array<{ id: string }> };
      if (json.files?.[0]) return json.files[0].id;
    }

    const criacao = await fetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: nome, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!criacao.ok) throw new Error(`não consegui criar a pasta no Drive: ${criacao.status}`);

    const { id } = (await criacao.json()) as { id: string };
    log.info('pasta criada no Drive', { nome });
    return id;
  }

  async enviar(pastaId: string, nome: string, conteudo: Buffer): Promise<ArquivoDrive> {
    const token = await this.token();
    const limite = `gideao${randomBytes(12).toString('hex')}`;

    const metadados = JSON.stringify({ name: nome, parents: [pastaId] });
    const corpo = Buffer.concat([
      Buffer.from(
        `--${limite}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadados}\r\n` +
          `--${limite}\r\ncontent-type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
      conteudo,
      Buffer.from(`\r\n--${limite}--\r\n`, 'utf8'),
    ]);

    const res = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,size,createdTime`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${limite}`,
      },
      body: corpo,
      signal: AbortSignal.timeout(10 * 60_000),
    });

    if (!res.ok) {
      throw new Error(`o Drive recusou o envio (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }

    const arquivo = (await res.json()) as ArquivoDrive & { size?: string };
    return { ...arquivo, size: Number(arquivo.size ?? conteudo.length) };
  }

  async listar(pastaId: string, limite = 30): Promise<ArquivoDrive[]> {
    const token = await this.token();
    const q = encodeURIComponent(`'${pastaId}' in parents and trashed = false`);
    const res = await fetch(
      `${API}/files?q=${q}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=${limite}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`não consegui listar o Drive (${res.status})`);

    const json = (await res.json()) as { files?: Array<ArquivoDrive & { size?: string }> };
    return (json.files ?? []).map((f) => ({ ...f, size: Number(f.size ?? 0) }));
  }

  async baixar(arquivoId: string): Promise<Buffer> {
    const token = await this.token();
    const res = await fetch(`${API}/files/${arquivoId}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw new Error(`não consegui baixar do Drive (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async apagar(arquivoId: string): Promise<void> {
    const token = await this.token();
    const res = await fetch(`${API}/files/${arquivoId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`não consegui apagar do Drive (${res.status})`);
    }
  }
}

const PAGINA_OK = `<!doctype html><meta charset="utf-8"><title>Gideão</title>
<style>body{background:#05050a;color:#e9e9f2;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center}</style>
<div><h1>Pronto</h1><p>Pode fechar esta aba e voltar para o terminal.</p></div>`;

const PAGINA_ERRO = (erro: string) => `<!doctype html><meta charset="utf-8"><title>Gideão</title>
<style>body{background:#05050a;color:#ff9b9b;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center}</style>
<div><h1>Não deu</h1><p>${erro.replace(/[<>&]/g, '')}</p></div>`;
