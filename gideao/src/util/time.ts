/** Utilidades de data/hora conscientes de fuso, em português. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatDateTime(date: Date, timezone: string, locale = 'pt-BR'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
}

export function formatShort(date: Date, timezone: string, locale = 'pt-BR'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** "há 3 dias", "em 2 horas" */
export function relative(target: Date, from = new Date(), locale = 'pt-BR'): string {
  const diffMs = target.getTime() - from.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['week', 604800000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (Math.abs(diffMs) >= ms || unit === 'second') {
      return rtf.format(Math.round(diffMs / ms), unit);
    }
  }
  return 'agora';
}

export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*(s|seg|m|min|h|hora|horas|d|dia|dias|sem|semana|semanas)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit.startsWith('s') && !unit.startsWith('sem')) return n * 1000;
  if (unit.startsWith('m')) return n * 60_000;
  if (unit.startsWith('h')) return n * 3_600_000;
  if (unit.startsWith('d')) return n * 86_400_000;
  if (unit.startsWith('sem')) return n * 604_800_000;
  return null;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
