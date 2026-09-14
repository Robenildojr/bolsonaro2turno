/**
 * Navegador de verdade (Playwright), com perfil persistente.
 *
 * Perfil persistente é o detalhe que muda tudo no uso jurídico: o login feito
 * uma vez no PJe continua valendo nas próximas sessões, como no seu navegador
 * do dia a dia. Sem isso, cada consulta exigiria autenticar de novo.
 *
 * O Playwright é dependência opcional. Se não estiver instalado, as ferramentas
 * de navegador se explicam em vez de quebrar o sistema todo.
 */
import fs from 'node:fs';
import { paths } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';

const log = createLogger('navegador');

// Tipagem mínima: evita depender dos tipos do Playwright em tempo de compilação.
interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  content(): Promise<string>;
  innerText(selector: string, opts?: Record<string, unknown>): Promise<string>;
  click(selector: string, opts?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, opts?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, opts?: Record<string, unknown>): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  waitForSelector(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<void>;
  evaluate<T>(fn: string | ((...args: never[]) => T)): Promise<T>;
  close(): Promise<void>;
  isClosed(): boolean;
}

interface PwContext {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
  close(): Promise<void>;
}

export class BrowserSession {
  private context: PwContext | null = null;
  private page: PwPage | null = null;
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await import('playwright');
      this.available = true;
    } catch {
      this.available = false;
      log.warn('playwright não está instalado — as ferramentas de navegador ficam indisponíveis');
    }
    return this.available;
  }

  /** Abre (ou reaproveita) o contexto persistente. */
  private async ensureContext(): Promise<PwContext> {
    if (this.context) return this.context;
    if (!(await this.isAvailable())) {
      throw new Error(
        'o navegador não está disponível: instale com `npm i playwright && npx playwright install chromium`',
      );
    }

    const { chromium } = (await import('playwright')) as unknown as {
      chromium: {
        launchPersistentContext(dir: string, opts: Record<string, unknown>): Promise<PwContext>;
      };
    };

    const profileDir = paths().browser;
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: process.env.IRIS_BROWSER_HEADLESS !== 'false',
      viewport: { width: 1440, height: 900 },
      locale: 'pt-BR',
      timezoneId: process.env.IRIS_TZ || 'America/Sao_Paulo',
      acceptDownloads: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    log.info('navegador aberto', { perfil: profileDir });
    return this.context;
  }

  async currentPage(): Promise<PwPage> {
    const context = await this.ensureContext();
    if (this.page && !this.page.isClosed()) return this.page;
    const existing = context.pages().find((p) => !p.isClosed());
    this.page = existing ?? (await context.newPage());
    return this.page;
  }

  async goto(url: string): Promise<{ title: string; url: string }> {
    const page = await this.currentPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Sites de tribunal costumam montar a tela depois do load inicial.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    return { title: await page.title(), url: page.url() };
  }

  /** Texto legível da página, sem script, estilo e navegação repetida. */
  async readText(): Promise<string> {
    const page = await this.currentPage();
    return page.evaluate(`(() => {
      const lixo = document.querySelectorAll('script, style, noscript, svg, iframe');
      lixo.forEach((el) => el.remove());
      const alvo = document.querySelector('main, #main, .container, body') || document.body;
      return (alvo.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    })()`);
  }

  /** Campos e botões da página — ajuda o modelo a saber o que preencher. */
  async describeForm(): Promise<string> {
    const page = await this.currentPage();
    return page.evaluate(`(() => {
      const linhas = [];
      document.querySelectorAll('input, select, textarea, button, a[href]').forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'input' && ['hidden'].includes(el.type)) return;
        const id = el.id ? '#' + el.id : '';
        const name = el.getAttribute('name');
        const rotulo = (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
                        (el.labels && el.labels[0] && el.labels[0].innerText) ||
                        el.innerText || el.value || '').toString().trim().slice(0, 80);
        const seletor = id || (name ? tag + '[name="' + name + '"]' : '');
        if (!seletor && !rotulo) return;
        const tipo = tag === 'input' ? 'input:' + (el.type || 'text') : tag;
        linhas.push(tipo + ' ' + (seletor || '(sem seletor)') + (rotulo ? ' — ' + rotulo : ''));
      });
      return linhas.slice(0, 120).join('\\n');
    })()`);
  }

  async fill(selector: string, value: string): Promise<void> {
    const page = await this.currentPage();
    await page.waitForSelector(selector, { timeout: 20_000, state: 'visible' });
    await page.fill(selector, value, { timeout: 20_000 });
  }

  async click(selector: string): Promise<void> {
    const page = await this.currentPage();
    await page.waitForSelector(selector, { timeout: 20_000, state: 'visible' });
    await page.click(selector, { timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  async press(selector: string, key: string): Promise<void> {
    const page = await this.currentPage();
    await page.press(selector, key, { timeout: 20_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  async screenshot(file: string): Promise<string> {
    const page = await this.currentPage();
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
      log.info('navegador fechado');
    } catch (err) {
      log.warn('erro ao fechar o navegador', { erro: describeError(err) });
    } finally {
      this.context = null;
      this.page = null;
    }
  }

  get isOpen(): boolean {
    return this.context !== null;
  }
}

let singleton: BrowserSession | null = null;

export function getBrowser(): BrowserSession {
  if (!singleton) singleton = new BrowserSession();
  return singleton;
}

export async function closeBrowser(): Promise<void> {
  if (singleton) await singleton.close();
}
