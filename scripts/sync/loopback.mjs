// Autorisation OAuth sur le poste : ouvre le navigateur et récupère le code sur http://127.0.0.1:<port>.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

export const b64url = (buf) => buf.toString('base64url');

/** PKCE (S256) + state */
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
    state: b64url(randomBytes(16)),
  };
}

/**
 * Démarre le serveur loopback ; `authorize(redirect)` construit l'URL d'autorisation.
 * Renvoie { code, redirect, scope } une fois la redirection reçue (scope : accordé, si le fournisseur le renvoie).
 */
export async function loopbackCode({ port = 0, path = '/', host = '127.0.0.1', state, authorize }) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  // Les clients Google « Web » exigent « localhost » (le navigateur retombe sur 127.0.0.1)
  const redirect = `http://${host}:${server.address().port}${path}`;
  const url = authorize(redirect);
  console.log(`\nSi le navigateur ne s'ouvre pas, ouvre cette adresse :\n  ${url}\n`);
  execFile('open', [url], () => {});

  const query = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Autorisation non reçue après 5 minutes'));
    }, 300_000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.has('code') && !q.has('error')) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        q.get('code')
          ? 'RunStat : autorisation reçue, tu peux fermer cet onglet.'
          : 'Autorisation refusée.',
      );
      clearTimeout(timer);
      server.close();
      if (q.get('state') !== state) reject(new Error('Paramètre state inattendu'));
      else if (q.get('error'))
        reject(new Error(`${q.get('error')} ${q.get('error_description') ?? ''}`));
      else resolve(q);
    });
  });
  return { code: query.get('code'), redirect, scope: query.get('scope') };
}
