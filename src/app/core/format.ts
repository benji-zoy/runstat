const formatters = [0, 1, 2, 3, 4].map((d) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }));

export function num(n: number, digits: 0 | 1 | 2 | 3 | 4 = 0): string {
  return formatters[digits].format(n);
}

/** Nombre avec un nombre fixe de décimales : fixed(1.1, 2) → "1,10" */
export function fixed(n: number, digits: number): string {
  return n.toFixed(digits).replace('.', ',');
}

/** Nombre « lisible » : 1 décimale sous 10, entier au-delà. */
export function smart(n: number): string {
  if (n < 10) return num(n, n < 1 ? 2 : 1);
  return num(n);
}

export function km(n: number): string {
  return `${num(n, n < 100 ? 1 : 0)} km`;
}

/** 3725 -> "1 h 02" ; 7_200_000 -> "2 000 h" */
export function duration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (h >= 100) return `${num(h)} h`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/** 336 -> "5:36" */
export function pace(secPerKm: number | null | undefined): string {
  if (!secPerKm || !isFinite(secPerKm)) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/** 4290 -> "1:11:30" */
export function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * Durée saisie → secondes : « 1:35:00 », « 35:20 » (min:s), « 1h35 », « 10 h 30 », « 1h35'20 », « 95' », « 95 min »,
 * « 95 » (minutes). null si illisible.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = s.match(/^(\d+):([0-5]?\d)(?::([0-5]\d))?$/);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  // Les secondes demandent un séparateur de minutes : « 1h75 » est refusé, pas lu 1 h 07 min 05 s
  m = s.match(/^(\d+)h(?:([0-5]?\d)(?:(?:min|mn|m|')(?:([0-5]?\d)(?:s|"|'')?)?)?)?$/);
  if (m) return +m[1] * 3600 + +(m[2] ?? 0) * 60 + +(m[3] ?? 0);
  m = s.match(/^(\d+)(?:(?:min|mn|m|')(?:([0-5]?\d)(?:s|"|'')?)?)?$/);
  if (m) return +m[1] * 60 + +(m[2] ?? 0);
  return null;
}

/** « 7, 14, 21,5 » ou « 7 ; 14 » → [7, 14, 21.5] (virgule décimale collée aux chiffres) ; null si un élément est illisible */
export function parseKmList(text: string): number[] | null {
  const parts = text.split(/[;\s]+|,(?!\d)/).filter(Boolean);
  const out = parts.map((p) => Number(p.replace(',', '.')));
  return out.some((k) => !Number.isFinite(k) || k < 0 || k > 500) ? null : out.sort((a, b) => a - b);
}

const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });

export function day(d: Date): string {
  return dayFmt.format(d);
}

export function month(d: Date): string {
  return monthFmt.format(d);
}
