// Client COROS MCP (HTTP sans session, OAuth 2.0) en lecture seule, portable (NAS et navigateur : le MCP, l'OAuth et
// l'enregistrement dynamique de COROS acceptent le CORS). Autorisation : client public enregistré dynamiquement pour une
// adresse de retour, puis code + PKCE. Jetons : coros-client.json et coros-tokens.json du magasin du compte.
import { fetchRetry, globalFetch, guardedRefresh, postForm, ReauthRequired, type Fetch, type TokenStore } from './http.ts';

export const COROS_MCP_URL = 'https://mcpeu.coros.com/mcp';
export const COROS_SCOPE = 'openid mcp.tools offline_access';
const PROTOCOL = '2025-06-18';

/** Seuls outils appelables. Les outils d'écriture (create…, update…, schedule…) n'y figurent pas. */
export const READ_TOOLS = new Set([
  'querySportRecords',
  'getActivityDetail',
  'queryActivityLapData',
  'queryActivityFitFileDownloadUrls',
  'querySleepOverview',
  'querySleepHrv',
  'queryRestingHeartRate',
  'queryAvgHeartRate',
  'queryDailyHealthData',
  'queryRecoveryStatus',
  'queryTrainingLoadAssessment',
  'queryFitnessAssessmentOverview',
]);

export interface CorosMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

export interface CorosClientInfo {
  issuer: string;
  client_id: string;
  redirect: string;
  registeredAt: string;
}

export interface CorosTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
  obtainedAt?: string;
}

/** Texte concaténé d'un résultat d'outil */
export const toolText = (result: any): string =>
  (result?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');

export interface CorosOptions {
  tokens: TokenStore;
  fetch?: Fetch;
  mcp?: string;
  clientName?: string;
}

export type CorosClient = ReturnType<typeof corosClient>;

export function corosClient({ tokens, fetch = globalFetch, mcp = COROS_MCP_URL, clientName = 'RunStat sync' }: CorosOptions) {
  const issuer = new URL(mcp).origin;
  let meta: CorosMeta | undefined;
  let rpcId = 0;

  async function metadata(): Promise<CorosMeta> {
    if (meta) return meta;
    const res = await fetchRetry(fetch, `${issuer}/.well-known/oauth-authorization-server`);
    if (!res.ok) throw new Error(`Métadonnées OAuth COROS : HTTP ${res.status}`);
    return (meta = (await res.json()) as CorosMeta);
  }

  /**
   * Client public pour `redirect`. Celui du compte est réutilisé s'il a la même adresse de retour ; sinon un nouveau est
   * enregistré. `persist` : écrit tout de suite ; sinon seulement après un échange réussi (exchangeCode), pour ne jamais
   * séparer le client des jetons qu'il a obtenus.
   */
  async function registerClient(m: CorosMeta, { redirect, persist = false }: { redirect: string; persist?: boolean }): Promise<CorosClientInfo> {
    const existing = await tokens.read<CorosClientInfo>('coros-client.json');
    if (existing?.issuer === issuer && existing.redirect === redirect) return existing;
    const res = await fetch(m.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        scope: COROS_SCOPE,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.client_id) throw new Error(`Enregistrement du client COROS refusé (HTTP ${res.status}) : ${JSON.stringify(body)}`);
    const client = { issuer, client_id: body.client_id, redirect, registeredAt: new Date().toISOString() };
    if (persist) await tokens.write('coros-client.json', client);
    return client;
  }

  async function saveTokens(body: Record<string, any>, previous?: CorosTokens | null): Promise<CorosTokens> {
    const t: CorosTokens = {
      access_token: body['access_token'],
      // Le serveur fait tourner le refresh token : on garde le nouveau dès qu'il arrive (un seul détenteur)
      refresh_token: body['refresh_token'] ?? previous?.refresh_token,
      expires_at: Date.now() + (body['expires_in'] ?? 3600) * 1000,
      scope: body['scope'] ?? previous?.scope,
      obtainedAt: body['refresh_token'] ? new Date().toISOString() : previous?.obtainedAt,
    };
    await tokens.write('coros-tokens.json', t);
    return t;
  }

  /** Adresse d'autorisation COROS (code + PKCE, ressource MCP) */
  function authorizeUrl(m: CorosMeta, client: CorosClientInfo, { redirect, challenge, state }: { redirect: string; challenge: string; state: string }): string {
    const url = new URL(m.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirect,
      scope: COROS_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: mcp,
    }).toString();
    return url.toString();
  }

  /** Échange du code ; écrit le client puis les jetons. Renvoie seulement les scopes : les jetons ne sortent pas d'ici. */
  async function exchangeCode(m: CorosMeta, client: CorosClientInfo, { code, verifier, redirect }: { code: string; verifier: string; redirect: string }) {
    const res = await postForm(fetch, m.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client.client_id,
      resource: mcp,
    });
    if (res.status !== 200 || !res.body['access_token']) throw new Error(`Échange du code COROS : ${res.body['error']} ${res.body['error_description'] ?? ''}`.trim());
    await tokens.write('coros-client.json', client);
    const t = await saveTokens(res.body);
    return { scope: t.scope, refresh: Boolean(t.refresh_token), expiresAt: t.expires_at };
  }

  async function accessToken(): Promise<string> {
    const current = await tokens.read<CorosTokens>('coros-tokens.json');
    const client = await tokens.read<CorosClientInfo>('coros-client.json');
    if (!current || !client) throw new ReauthRequired('coros', 'aucun token');
    if (current.expires_at - 60_000 > Date.now()) return current.access_token;
    return guardedRefresh<CorosTokens>(tokens, 'coros-tokens.json', async (t) => {
      if (!t?.refresh_token) throw new ReauthRequired('coros', 'token expiré sans refresh token');
      const res = await postForm(fetch, (await metadata()).token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
        client_id: client.client_id,
        resource: mcp,
      });
      if (res.status === 400 || res.status === 401) throw new ReauthRequired('coros', res.body['error'] ?? `HTTP ${res.status}`);
      if (res.status !== 200) throw new Error(`Refresh COROS : HTTP ${res.status}`);
      return (await saveTokens(res.body, t)).access_token;
    });
  }

  /** Requête JSON-RPC ; la réponse peut être du JSON ou un flux SSE */
  async function rpc(method: string, params?: unknown, { notification = false } = {}): Promise<any> {
    const token = await accessToken();
    const message: Record<string, unknown> = { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
    if (!notification) message['id'] = ++rpcId;
    // Outils en lecture seule : renvoyer la requête après une erreur 5xx est sans effet de bord
    const res = await fetchRetry(fetch, mcp, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL,
      },
      body: JSON.stringify(message),
    });
    if (res.status === 401) throw new ReauthRequired('coros', 'token refusé par le serveur MCP');
    if (notification) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${method} : HTTP ${res.status} ${text.slice(0, 300)}`);
    const payloads = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const reply = payloads.find((p) => p.id === message['id']);
    if (!reply) throw new Error(`MCP ${method} : réponse introuvable`);
    if (reply.error) throw new Error(`MCP ${method} : ${reply.error.code} ${reply.error.message}`);
    return reply.result;
  }

  async function initialize(): Promise<any> {
    const result = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'runstat-sync', version: '0.1.0' } });
    await rpc('notifications/initialized', undefined, { notification: true });
    return result;
  }

  async function listTools(): Promise<any[]> {
    const tools: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Appelle un outil de la liste blanche ; tout autre nom est refusé avant l'envoi */
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    if (!READ_TOOLS.has(name)) throw new Error(`Outil COROS non autorisé (lecture seule) : ${name}`);
    return rpc('tools/call', { name, arguments: args });
  }

  return { issuer, metadata, registerClient, authorizeUrl, exchangeCode, initialize, listTools, callTool, toolText, fetch };
}
