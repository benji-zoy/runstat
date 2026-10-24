// Outils communs des clients des sources (COROS, Strava, Google Health), sur le NAS (Node) comme dans le navigateur :
// fetch injecté, nouvelles tentatives, erreurs typées, magasin de jetons.

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** fetch global résolu à l'appel (les tests le remplacent après le chargement des modules) */
export const globalFetch: Fetch = (input, init) => globalThis.fetch(input, init);

/** Erreur d'autorisation persistante : la source doit être reconnectée (Réglages, ou npm run auth sur le poste) */
export class ReauthRequired extends Error {
  readonly source: string;
  constructor(source: string, detail: string) {
    super(`Ré-autorisation nécessaire pour ${source} (${detail})`);
    this.source = source;
  }
}

/** Limite de débit atteinte (429 ou quota presque épuisé) : on s'arrête proprement, suite à la prochaine synchro */
export class RateLimited extends Error {}

export interface RetryOptions {
  tries?: number;
  baseMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch avec nouvelles tentatives sur les erreurs passagères (réseau, 429, 5xx), délai croissant */
export async function fetchRetry(fetch: Fetch, url: string | URL, init: RequestInit = {}, { tries = 4, baseMs = 2000, timeoutMs = 60_000 }: RetryOptions = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let error: unknown;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      error = e;
    }
    const transient = error !== undefined || res!.status === 429 || res!.status >= 500;
    if (!transient || attempt >= tries) {
      if (error !== undefined) throw error;
      return res!;
    }
    const wait = baseMs * 2 ** (attempt - 1);
    const why = error !== undefined ? (error as Error).name : `HTTP ${res!.status}`;
    console.warn(`  ${new URL(url).host} : ${why}, nouvel essai dans ${wait / 1000} s`);
    await sleep(wait);
  }
}

/** POST d'un formulaire, réponse JSON (ou erreur lisible si ce n'en est pas) */
export async function postForm(fetch: Fetch, url: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetchRetry(fetch, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { error: `http_${res.status}`, error_description: text.slice(0, 300) } };
  }
}

/**
 * Jetons et clients OAuth d'un compte : dossier `secrets/` sur le NAS (scripts/sync/secrets.mjs), zone `raw` de l'appareil
 * (chiffrée dans la sauvegarde) en local-first. Jamais affichés.
 */
export interface TokenStore {
  read<T = any>(name: string): Promise<T | null>;
  write(name: string, value: unknown): Promise<void>;
  /** Date (ms) de la dernière écriture, null si absent : fin d'une pause « ré-autorisation » */
  savedAt(name: string): Promise<number | null>;
  /**
   * Renouvellement d'un jeton, sérialisé et autorisé par l'hôte : verrou entre onglets et appareil principal seul
   * (core/sources-sync.service.ts). Absent : appel direct (NAS, un seul run à la fois).
   */
  refresh?<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Renouvelle sous le contrôle du magasin, en relisant les jetons une fois le verrou pris (un autre onglet a pu le faire) */
export async function guardedRefresh<T extends { access_token: string; expires_at: number }>(
  tokens: TokenStore,
  name: string,
  renew: (current: T) => Promise<string>,
): Promise<string> {
  const run = async () => {
    const current = await tokens.read<T>(name);
    if (current && current.expires_at - 60_000 > Date.now()) return current.access_token;
    return renew(current as T);
  };
  return tokens.refresh ? tokens.refresh(name, run) : run();
}

/** Fichiers de jetons, avec leur date d'écriture (savedAt), dans un FileStore (zone raw de l'appareil) */
export function fileTokenStore(store: { readText(p: string): Promise<string | null>; write(p: string, d: string): Promise<void> }, dir = 'secrets'): TokenStore {
  return {
    async read(name) {
      const text = await store.readText(`${dir}/${name}`);
      if (text == null) return null;
      const { savedAt: _, ...value } = JSON.parse(text);
      return value;
    },
    async write(name, value) {
      await store.write(`${dir}/${name}`, JSON.stringify({ ...(value as object), savedAt: Date.now() }));
    },
    async savedAt(name) {
      const text = await store.readText(`${dir}/${name}`);
      return text == null ? null : (JSON.parse(text).savedAt ?? 0);
    },
  };
}
