// Contrôle des tours Coros (data-raw/laps) : format, somme des temps ≈ durée de la sortie, distance ≈ distance.
// Usage : node scripts/check-laps.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { activities } = JSON.parse(readFileSync(join(root, 'public/data/coros.json'), 'utf8'));
const byId = new Map(activities.map((a) => [a.id, a]));
let ok = 0;
for (const f of readdirSync(join(root, 'data-raw/laps')).filter((f) => f.endsWith('.json'))) {
  const id = f.replace('.json', '');
  const laps = JSON.parse(readFileSync(join(root, 'data-raw/laps', f), 'utf8'));
  const a = byId.get(id);
  if (laps.empty) { console.log(`${id} : vide`); continue; }
  const bad = laps.km.filter((l) => l.length !== 8 || l.some((x) => typeof x !== 'number'));
  const t = laps.km.reduce((s, l) => s + l[1], 0);
  const d = laps.km.reduce((s, l) => s + l[0], 0) / 1000;
  const dt = a ? Math.abs(t - a.durationSec) / a.durationSec : 1;
  const dd = a ? Math.abs(d - a.distanceKm) / a.distanceKm : 1;
  if (!a || bad.length || dt > 0.03 || dd > 0.03) console.log(`${id} ${a?.name ?? '?'} : ${bad.length} lignes invalides, temps ${t.toFixed(0)}/${a?.durationSec} s, distance ${d.toFixed(2)}/${a?.distanceKm} km`);
  else ok++;
}
console.log(`${ok} fichiers cohérents`);
