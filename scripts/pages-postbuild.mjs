// Après `ng build -c pages` (appli publique, GitHub Pages) : politique de sécurité du contenu en balise meta (Pages ne permet
// pas d'en-têtes HTTP), puis 404.html = index.html (routes Angular servies par la page d'erreur de Pages).
// RUNSTAT_NAS_ORIGINS : adresses publiques des NAS (Funnel), séparées par des virgules, seules joignables avec les services
// appelés depuis l'appareil. Usage : node scripts/pages-postbuild.mjs [dist/runstat-pages/browser]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist/runstat-pages/browser';
const nas = (process.env.RUNSTAT_NAS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => new URL(s).origin);

// Services appelés directement depuis l'appareil (tous acceptent le CORS de l'appli) et tuiles des cartes
const CONNECT = [
  'https://archive-api.open-meteo.com',
  'https://api.open-meteo.com',
  'https://mcpeu.coros.com',
  'https://s3eu.coros.com',
  'https://www.strava.com',
  'https://health.googleapis.com',
  'https://oauth2.googleapis.com',
];
const file = join(dir, 'index.html');
let html = readFileSync(file, 'utf8');
// Scripts en ligne (thème appliqué avant l'affichage, src/index.html) : autorisés par leur empreinte, pas en bloc
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
const csp = [
  "default-src 'self'",
  `script-src 'self' ${inline.join(' ')}`.trim(),
  // Styles des composants injectés par Angular et positions de Leaflet : attributs et balises style
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org",
  "font-src 'self'",
  `connect-src 'self' ${[...CONNECT, ...nas].join(' ')}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

if (html.includes('Content-Security-Policy')) throw new Error('CSP déjà présente');
html = html.replace('<head>', `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">\n  <meta name="referrer" content="no-referrer">`);
// Gestionnaire d'événement en ligne (onload… de l'inlining des styles critiques) : bloqué par la CSP, refusé ici
if (/\son[a-z]+="/.test(html)) throw new Error('gestionnaire d’événement en ligne : bloqué par la CSP');
writeFileSync(file, html);
writeFileSync(join(dir, '404.html'), html);
console.log(`CSP posée (${inline.length} script en ligne, ${nas.length} NAS connu${nas.length > 1 ? 's' : ''}), 404.html écrit.`);
