/**
 * Couleurs des graphiques et des cartes, toujours issues des variables CSS du thème (styles.scss).
 * Les configurations Chart.js gardent les références `var(--…)` ; `resolveColors` les remplace par les valeurs
 * du thème courant au moment de dessiner (canvas ne comprend pas les variables CSS).
 */
export const C = {
  accent: 'var(--accent)',
  s1: 'var(--series-1)',
  s1Hover: 'var(--series-1-hover)',
  s2: 'var(--series-2)',
  s3: 'var(--series-3)',
  s4: 'var(--series-4)',
  s5: 'var(--series-5)',
  s6: 'var(--series-6)',
  ghost: 'var(--ghost)',
  neutral: 'var(--neutral)',
  muted: 'var(--text-muted)',
  text: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  surface: 'var(--surface-1)',
  surface2: 'var(--surface-2)',
  border: 'var(--border)',
  bg: 'var(--bg)',
  bad: 'var(--bad)',
  amber: 'var(--amber)',
  good: 'var(--good)',
  goodText: 'var(--good-text)',
  seq2: 'var(--seq-2)',
  seq4: 'var(--seq-4)',
} as const;

/** Les quatre premières séries, dans l'ordre */
export const SERIES = [C.s1, C.s2, C.s3, C.s4];

/** Couleur du thème avec transparence (résolue au dessin) */
export const alpha = (color: string, a: number) => `alpha(${color},${a})`;

const VAR = /var\((--[\w-]+)\)/g;
const ALPHA = /alpha\(([^,]+),\s*([\d.]+)\)/g;

/** Valeur d'une variable CSS du thème courant */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Remplace `var(--x)` et `alpha(var(--x),a)` par des couleurs que le canvas sait dessiner */
export function resolveColor(value: string): string {
  if (!value.includes('var(') && !value.includes('alpha(')) return value;
  const withVars = value.replace(VAR, (_, name: string) => cssVar(name));
  return withVars.replace(ALPHA, (_, c: string, a: string) => withAlpha(c.trim(), Number(a)));
}

function withAlpha(color: string, a: number): string {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  const rgb = color.match(/^rgba?\(([^)]+)\)$/)?.[1].split(',').slice(0, 3).join(',');
  return rgb ? `rgba(${rgb},${a})` : color;
}

/**
 * Copie d'une configuration où chaque couleur est résolue. Les tableaux de données ne sont pas parcourus ;
 * une couleur calculée par une fonction (scriptable) est résolue à son retour.
 */
export function resolveColors<T>(value: T, key = ''): T {
  if (typeof value === 'string') return resolveColor(value) as T;
  if (typeof value === 'function') {
    if (!/colou?r$/i.test(key)) return value;
    const fn = value as (...args: unknown[]) => unknown;
    return ((...args: unknown[]) => {
      const out = fn(...args);
      return typeof out === 'string' ? resolveColor(out) : out;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveColors(v, key)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    // Les points d'une série (`data: [...]`) sont recopiés tels quels
    for (const [k, v] of Object.entries(value)) out[k] = k === 'data' && Array.isArray(v) ? v : resolveColors(v, k);
    return out as T;
  }
  return value;
}
