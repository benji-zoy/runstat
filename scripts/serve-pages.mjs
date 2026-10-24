// Sert le build de l'appli publique (`ng build -c pages` puis scripts/pages-postbuild.mjs) comme GitHub Pages : sous /runstat/,
// page 404.html pour les routes Angular. Pour vérifier en local (localhost = contexte sûr : service worker, WebCrypto, passkeys).
// Usage : node scripts/serve-pages.mjs [port]
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..', 'dist', 'runstat-pages', 'browser');
const port = Number(process.argv[2] ?? 4320);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith('/runstat/')) return res.writeHead(302, { Location: '/runstat/' }).end();
  const file = normalize(join(root, path.slice('/runstat/'.length) || 'index.html'));
  const ok = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
  const target = ok ? file : join(root, '404.html');
  res.writeHead(ok ? 200 : 404, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(target));
}).listen(port, () => console.log(`Appli publique sur http://localhost:${port}/runstat/`));
