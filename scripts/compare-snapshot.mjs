// Compare deux constructions du snapshot (avant / après un changement du moteur) : coros.json (hors generatedAt),
// routes.json, fit-derived/*.json et missing-details.txt, s'ils sont présents des deux côtés. Écarts listés par chemin.
// Usage : node scripts/compare-snapshot.mjs <dossier avant> <dossier après>
//   Chaque dossier contient coros.json, routes.json et éventuellement fit-derived/ et missing-details.txt
//   (copie de public/data/ et de data-raw/). Code de sortie 1 s'il y a des écarts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('Usage : node scripts/compare-snapshot.mjs <dossier avant> <dossier après>');
  process.exit(2);
}

const MAX = 30;
const diffs = [];
const note = (path, msg) => diffs.push(`${path} : ${msg}`);
const show = (v) => (v === undefined ? 'absent' : JSON.stringify(v)?.slice(0, 80));

function compare(x, y, path) {
  if (Object.is(x, y)) return;
  if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object' || Array.isArray(x) !== Array.isArray(y)) {
    return note(path, `${show(x)} → ${show(y)}`);
  }
  if (Array.isArray(x)) {
    if (x.length !== y.length) note(path, `longueur ${x.length} → ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) compare(x[i], y[i], `${path}[${i}]`);
    return;
  }
  const kx = Object.keys(x), ky = Object.keys(y);
  for (const k of new Set([...kx, ...ky])) compare(x[k], y[k], `${path}.${k}`);
  // Même contenu, ordre des clés différent : JSON différent octet par octet
  if (kx.join() !== ky.join() && kx.length === ky.length && kx.every((k) => k in y)) note(path, 'ordre des clés différent');
}

const json = (dir, f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const both = (f) => existsSync(join(a, f)) && existsSync(join(b, f));
let files = 0;

if (both('coros.json')) {
  const [x, y] = [json(a, 'coros.json'), json(b, 'coros.json')];
  delete x.generatedAt;
  delete y.generatedAt;
  // Sorties indexées par identifiant : un décalage d'une sortie ne masque pas les autres écarts
  const ids = (s) => s.activities?.map((act) => act.id).join();
  if (ids(x) === ids(y)) {
    x.activities.forEach((act, i) => compare(act, y.activities[i], `coros.activities[${act.id}]`));
    delete x.activities;
    delete y.activities;
  }
  compare(x, y, 'coros');
  files++;
}
if (both('routes.json')) compare(json(a, 'routes.json'), json(b, 'routes.json'), 'routes'), files++;
if (both('missing-details.txt')) {
  if (readFileSync(join(a, 'missing-details.txt'), 'utf8') !== readFileSync(join(b, 'missing-details.txt'), 'utf8')) {
    note('missing-details.txt', 'contenu différent');
  }
  files++;
}
if (both('fit-derived')) {
  const list = (d) => readdirSync(join(d, 'fit-derived')).filter((f) => f.endsWith('.json')).sort();
  const [la, lb] = [list(a), list(b)];
  for (const f of la.filter((f) => !lb.includes(f))) note(`fit-derived/${f}`, 'absent après');
  for (const f of lb.filter((f) => !la.includes(f))) note(`fit-derived/${f}`, 'absent avant');
  for (const f of la.filter((f) => lb.includes(f))) compare(json(a, `fit-derived/${f}`), json(b, `fit-derived/${f}`), `fit-derived/${f}`), files++;
}

if (!files) {
  console.error('Rien à comparer : coros.json, routes.json, fit-derived/ ou missing-details.txt attendus des deux côtés');
  process.exit(2);
}
if (diffs.length) {
  console.log(`${diffs.length} écart(s) sur ${files} fichier(s) :`);
  for (const d of diffs.slice(0, MAX)) console.log(`  ${d}`);
  if (diffs.length > MAX) console.log(`  … et ${diffs.length - MAX} autres`);
  process.exit(1);
}
console.log(`Aucun écart sur ${files} fichier(s) (generatedAt ignoré).`);
