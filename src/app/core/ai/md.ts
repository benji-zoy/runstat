/**
 * Petit assembleur de Markdown pour les exports vers une IA : titres, paires clé-valeur, tableaux compacts, et
 * suivi des notions employées pour n'écrire dans le glossaire que celles qui servent.
 * Markdown volontairement simple (titres, listes, tableaux) : lisible par n'importe quel assistant.
 */
import { GLOSSARY, GlossaryKey } from './glossary';

export type Cell = string | number | null | undefined;

const DAY_NAMES = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

/** Nombre à la française, `digits` décimales au plus ; « – » si absent */
export function n(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(x).replace(/ /g, ' ');
}

/** Pourcentage signé : +1,2 % / −0,8 % */
export function signedPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  return `${x < 0 ? '−' : '+'}${n(Math.abs(x), digits)} %`;
}

/** Allure (s/km) → « 5:12 » */
export function pace(sec: number | null | undefined): string {
  if (!sec || !Number.isFinite(sec)) return '–';
  let m = Math.floor(sec / 60);
  let s = Math.round(sec % 60);
  if (s === 60) { m++; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Durée → « 1:02:05 » ou « 42:10 » */
export function clock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

/** Durée lisible → « 1 h 05 » ou « 42 min » */
export function hm(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const min = Math.round(sec / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

/** Jour ISO avec le jour de la semaine : « 2026-10-12 (dim.) » */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${iso} (${DAY_NAMES[new Date(y, m - 1, d).getDay()]})`;
}

/** Échappe le séparateur de colonnes et les retours à la ligne d'une cellule */
const cell = (c: Cell) => (c === null || c === undefined || c === '' ? '–' : String(c).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' '));

/** Texte libre saisi par la personne : une seule ligne de titre ne doit pas casser la structure du document */
export const inline = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export class MdDoc {
  private readonly parts: string[] = [];
  private readonly terms = new Set<GlossaryKey>();

  /** Notions employées : le glossaire n'explique que celles-là */
  use(...keys: GlossaryKey[]): this {
    for (const k of keys) this.terms.add(k);
    return this;
  }

  h(level: 2 | 3, title: string): this {
    this.parts.push(`${'#'.repeat(level)} ${title}`);
    return this;
  }

  p(text: string | null | undefined): this {
    if (text && text.trim()) this.parts.push(text.trim());
    return this;
  }

  /** Liste à puces ; les éléments vides sont ignorés */
  list(items: (string | null | undefined | false)[]): this {
    const xs = items.filter((x): x is string => !!x && !!x.trim());
    if (xs.length) this.parts.push(xs.map((x) => `- ${x}`).join('\n'));
    return this;
  }

  /** Paires « clé : valeur » en liste, sans les valeurs absentes */
  facts(pairs: [string, Cell][]): this {
    return this.list(pairs.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '–').map(([k, v]) => `${k} : ${v}`));
  }

  table(head: string[], rows: Cell[][]): this {
    if (!rows.length) return this;
    const line = (cs: Cell[]) => `| ${cs.map(cell).join(' | ')} |`;
    this.parts.push([line(head), `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(line)].join('\n'));
    return this;
  }

  /** Glossaire des notions employées, dans l'ordre du dictionnaire */
  glossary(): string {
    const keys = (Object.keys(GLOSSARY) as GlossaryKey[]).filter((k) => this.terms.has(k));
    if (!keys.length) return '';
    return ['## Glossaire', keys.map((k) => `- **${GLOSSARY[k].term}** : ${GLOSSARY[k].text}`).join('\n')].join('\n\n');
  }

  body(): string {
    return this.parts.join('\n\n');
  }
}
