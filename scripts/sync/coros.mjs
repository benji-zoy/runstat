// Client COROS MCP en lecture seule : enveloppe Node du client portable (src/engine/sync/coros.ts) sur un dossier de secrets.
// Autorisation : depuis le site (Réglages › « Connecter COROS », oauth-connect.mjs) ou en secours sur le poste (loopback,
// npm run auth -- coros, puis copie des jetons sur le NAS).
import { corosClient, READ_TOOLS, toolText } from '#engine/sync/coros.ts';
import { nodeTokens, secretsDir } from './secrets.mjs';
import { pkce, loopbackCode } from './loopback.mjs';

export const COROS_MCP = process.env.COROS_MCP_URL ?? 'https://mcpeu.coros.com/mcp';
const REDIRECT = 'http://127.0.0.1:53682/callback';

export { READ_TOOLS, toolText };

/** Client d'un dossier de secrets (`dir` : compte du service, sinon celui du run) */
export const corosAt = (dir = secretsDir()) => corosClient({ tokens: nodeTokens(dir), mcp: COROS_MCP });
let run;
const current = () => (run ??= corosAt());

export const metadata = () => current().metadata();

/**
 * Client public pour `redirect` (loopback du poste, ou adresse du site : oauth-connect.mjs). `persist` : écrit tout de suite
 * dans coros-client.json (poste) ; le site ne l'écrit qu'après un échange réussi.
 */
export const registerClient = (meta, { redirect = REDIRECT, persist = true, dir } = {}) => corosAt(dir).registerClient(meta, { redirect, persist });

export const authorizeUrl = (meta, client, opts) => current().authorizeUrl(meta, client, opts);

/** Échange du code ; écrit le client puis les jetons dans `dir` (secrets du compte). Renvoie seulement les scopes. */
export const exchangeCode = (meta, client, { code, verifier, redirect, dir }) => corosAt(dir).exchangeCode(meta, client, { code, verifier, redirect });

/** Autorisation interactive sur le poste (navigateur + loopback, PKCE), en secours de Réglages › « Connecter COROS » */
export async function authorizeCoros() {
  const meta = await metadata();
  const client = await registerClient(meta);
  const { verifier, challenge, state } = pkce();
  const { code } = await loopbackCode({
    port: Number(new URL(REDIRECT).port),
    path: new URL(REDIRECT).pathname,
    state,
    authorize: (redirect) => authorizeUrl(meta, client, { redirect, challenge, state }),
  });
  const t = await exchangeCode(meta, client, { code, verifier, redirect: REDIRECT });
  const ttl = Math.round((t.expiresAt - Date.now()) / 60000);
  console.log(`COROS autorisé (scopes : ${t.scope ?? '?'}, access token ${ttl} min, refresh token : ${t.refresh ? 'oui' : 'NON'}).`);
}

export const initialize = () => current().initialize();
export const listTools = () => current().listTools();
/** Appelle un outil de la liste blanche ; tout autre nom est refusé avant l'envoi */
export const callTool = (name, args = {}) => current().callTool(name, args);
