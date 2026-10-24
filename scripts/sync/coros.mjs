// Client COROS MCP (HTTP sans session, OAuth 2.0) en lecture seule.
// Autorisation : enregistrement dynamique d'un client public, puis code + PKCE avec redirection
// loopback, sur le poste (le serveur refuse le device flow à ces clients). Le refresh token est
// ensuite copié sur le volume du NAS.
import { readSecret, writeSecret, ReauthRequired } from './secrets.mjs';
import { pkce, loopbackCode } from './loopback.mjs';
import { fetchRetry } from './retry.mjs';

export const COROS_MCP = process.env.COROS_MCP_URL ?? 'https://mcpeu.coros.com/mcp';
const ISSUER = new URL(COROS_MCP).origin;
const SCOPE = 'openid mcp.tools offline_access';
const REDIRECT = 'http://127.0.0.1:53682/callback';
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

async function postForm(url, params) {
  const res = await fetchRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: `http_${res.status}`, error_description: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

let meta;
async function metadata() {
  if (meta) return meta;
  const res = await fetchRetry(`${ISSUER}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`Métadonnées OAuth COROS : HTTP ${res.status}`);
  return (meta = await res.json());
}

/** Enregistre (une fois) un client public. Le serveur n'accorde que authorization_code + refresh_token. */
async function registerClient(meta) {
  const existing = readSecret('coros-client.json');
  if (existing?.issuer === ISSUER && existing.redirect === REDIRECT) return existing;
  const res = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'RunStat sync',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) {
    throw new Error(
      `Enregistrement du client COROS refusé (HTTP ${res.status}) : ${JSON.stringify(body)}`,
    );
  }
  const client = {
    issuer: ISSUER,
    client_id: body.client_id,
    redirect: REDIRECT,
    registeredAt: new Date().toISOString(),
  };
  writeSecret('coros-client.json', client);
  return client;
}

function saveTokens(body, previous) {
  const tokens = {
    access_token: body.access_token,
    // Le serveur peut faire tourner le refresh token : on garde le nouveau dès qu'il arrive.
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 3600) * 1000,
    scope: body.scope ?? previous?.scope,
    obtainedAt: body.refresh_token ? new Date().toISOString() : previous?.obtainedAt,
  };
  writeSecret('coros-tokens.json', tokens);
  return tokens;
}

/** Autorisation interactive sur le poste (navigateur + loopback, PKCE) */
export async function authorizeCoros() {
  const meta = await metadata();
  const client = await registerClient(meta);
  const { verifier, challenge, state } = pkce();
  const { code } = await loopbackCode({
    port: Number(new URL(REDIRECT).port),
    path: new URL(REDIRECT).pathname,
    state,
    authorize: (redirect) => {
      const url = new URL(meta.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirect,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        resource: COROS_MCP,
      });
      return url.toString();
    },
  });
  const res = await postForm(meta.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    resource: COROS_MCP,
  });
  if (res.status !== 200) {
    throw new Error(
      `Échange du code COROS : ${res.body.error} ${res.body.error_description ?? ''}`,
    );
  }
  const t = saveTokens(res.body);
  const ttl = Math.round((t.expires_at - Date.now()) / 60000);
  console.log(
    `COROS autorisé (scopes : ${t.scope ?? '?'}, access token ${ttl} min, refresh token : ${t.refresh_token ? 'oui' : 'NON'}).`,
  );
}

async function accessToken() {
  const tokens = readSecret('coros-tokens.json');
  const client = readSecret('coros-client.json');
  if (!tokens || !client) throw new ReauthRequired('coros', 'aucun token');
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  if (!tokens.refresh_token) throw new ReauthRequired('coros', 'token expiré sans refresh token');
  const meta = await metadata();
  const res = await postForm(meta.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
    resource: COROS_MCP,
  });
  if (res.status === 400 || res.status === 401) {
    throw new ReauthRequired('coros', res.body.error ?? `HTTP ${res.status}`);
  }
  if (res.status !== 200) throw new Error(`Refresh COROS : HTTP ${res.status}`);
  return saveTokens(res.body, tokens).access_token;
}

let rpcId = 0;

/** Requête JSON-RPC ; la réponse peut être du JSON ou un flux SSE */
async function rpc(method, params, { notification = false } = {}) {
  const token = await accessToken();
  const message = { jsonrpc: '2.0', method, ...(params && { params }) };
  if (!notification) message.id = ++rpcId;
  // Outils en lecture seule : renvoyer la requête après une erreur 5xx est sans effet de bord
  const res = await fetchRetry(COROS_MCP, {
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
  const reply = payloads.find((p) => p.id === message.id);
  if (!reply) throw new Error(`MCP ${method} : réponse introuvable`);
  if (reply.error) throw new Error(`MCP ${method} : ${reply.error.code} ${reply.error.message}`);
  return reply.result;
}

export async function initialize() {
  const result = await rpc('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'runstat-sync', version: '0.1.0' },
  });
  await rpc('notifications/initialized', undefined, { notification: true });
  return result;
}

export async function listTools() {
  const tools = [];
  let cursor;
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Appelle un outil de la liste blanche ; tout autre nom est refusé avant l'envoi */
export async function callTool(name, args = {}) {
  if (!READ_TOOLS.has(name)) throw new Error(`Outil COROS non autorisé (lecture seule) : ${name}`);
  return rpc('tools/call', { name, arguments: args });
}

/** Texte concaténé d'un résultat d'outil */
export const toolText = (result) =>
  (result?.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
