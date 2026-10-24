// Client de l'API publique du NAS (scripts/sync/public-api.mjs) : sauvegarde (/backup), session (/auth). Jeton de session en
// Authorization: Bearer ; `fetch` injecté (navigateur, tests contre le vrai serveur Node).
import { Conflict, type BackupApi, type BackupHeader, type RemoteManifest } from './sync.ts';

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? (body['error'] as string) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Adresse du NAS normalisée (origine HTTPS, ou http://localhost pour les essais) ; null si invalide */
export function nasOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export interface PublicClient {
  backup: BackupApi;
  /** Requête JSON authentifiée (ou non, sans jeton) */
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export function publicClient(nas: string, token: () => string | null, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): PublicClient {
  const base = nasOrigin(nas);
  if (!base) throw new Error('adresse du NAS invalide');
  const headers = (extra: Record<string, string> = {}) => {
    const t = token();
    return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
  };
  async function call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await fetchImpl(`${base}${path}`, { method, headers: headers(init.headers), body: init.body, cache: 'no-store' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 412) throw new Conflict(typeof body['current'] === 'number' ? (body['current'] as number) : null);
      throw new ApiError(res.status, body);
    }
    return res;
  }
  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await call(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    return (res.status === 204 ? null : await res.json()) as T;
  }
  const backup: BackupApi = {
    async getManifest() {
      try {
        return await json<RemoteManifest>('GET', '/backup/manifest');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    listManifests: () => json('GET', '/backup/manifests'),
    getManifestVersion: (v) => json('GET', `/backup/manifests/${v}`),
    async putManifest(body: { version: number; header: BackupHeader; blob: string; objects: string[] }, expected) {
      await call('PUT', '/backup/manifest', {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...(expected == null ? { 'If-None-Match': '*' } : { 'If-Match': `"v${expected}"` }) },
      });
    },
    missing: async (ids) => (await json<{ missing: string[] }>('POST', '/backup/objects/missing', { ids })).missing,
    async putObject(id, data) {
      await call('PUT', `/backup/objects/${id}`, { body: data as Uint8Array<ArrayBuffer>, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    async getObject(id) {
      return new Uint8Array(await (await call('GET', `/backup/objects/${id}`)).arrayBuffer());
    },
  };
  return { backup, json };
}
