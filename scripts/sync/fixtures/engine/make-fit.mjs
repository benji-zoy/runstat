// Génère sortie.fit : une sortie fictive de 45 min (aucune donnée réelle), pour les tests du moteur
// (src/engine/*.spec.ts). Boucle autour d'un point imaginaire, côte au milieu, FC qui dérive, cadence, puissance,
// température, trois tours. Usage : node scripts/sync/fixtures/engine/make-fit.mjs
import { writeFileSync } from 'node:fs';
import { FitBaseType as T, FitEncoder } from 'fit-file-parser/encoder';

const out = new URL('./sortie.fit', import.meta.url);
const start = new Date('2026-03-01T08:00:00Z');
const ts = (s) => FitEncoder.toFitTimestamp(start) + s;
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);
const f = (number, size, baseType, value) => ({ number, size, baseType, value });

const enc = new FitEncoder();
// file_id : activité
enc.writeMessage(0, [f(0, 1, T.Enum, 4), f(1, 2, T.Uint16, 255), f(4, 4, T.Uint32, ts(0))]);
// event : chrono démarré
enc.writeMessage(21, [f(253, 4, T.Uint32, ts(0)), f(0, 1, T.Enum, 0), f(1, 1, T.Enum, 0)], 1);

const DURATION = 45 * 60;
const lat0 = 45.0, lon0 = 5.0;
let dist = 0;
const laps = [];
let lapStart = { t: 0, d: 0 };
for (let s = 0; s <= DURATION; s++) {
  // Vitesse : 3,2 m/s, ralentie dans la côte (min 15 à 25), plus vite à la descente
  const climbing = s >= 900 && s < 1500, descending = s >= 1500 && s < 1800;
  const v = climbing ? 2.6 : descending ? 3.6 : 3.2;
  if (s > 0) dist += v;
  const alt = 200 + (climbing ? (s - 900) * 0.1 : descending ? 60 - (s - 1500) * 0.2 : s >= 1800 ? 0 : 0);
  // Boucle de ~1,4 km de rayon parcourue dans le sens des aiguilles d'une montre
  const angle = dist / 1400;
  const lat = lat0 + (1400 / 111_320) * Math.cos(angle);
  const lon = lon0 + (1400 / (111_320 * Math.cos((lat0 * Math.PI) / 180))) * Math.sin(angle);
  const hr = Math.round(135 + s / 120 + (climbing ? 15 : 0));
  enc.writeMessage(
    20,
    [
      f(253, 4, T.Uint32, ts(s)),
      f(0, 4, T.Sint32, semi(lat)),
      f(1, 4, T.Sint32, semi(lon)),
      f(5, 4, T.Uint32, Math.round(dist * 100)),
      f(6, 2, T.Uint16, Math.round(v * 1000)),
      f(78, 4, T.Uint32, Math.round((alt + 500) * 5)),
      f(3, 1, T.Uint8, hr),
      f(4, 1, T.Uint8, climbing ? 82 : 86),
      f(7, 2, T.Uint16, Math.round(v * 75)),
      f(13, 1, T.Sint8, 12),
    ],
    2,
  );
  if (s > 0 && s % 900 === 0) {
    laps.push({ t: s, timer: s - lapStart.t, d: dist - lapStart.d });
    lapStart = { t: s, d: dist };
  }
}
enc.writeMessage(21, [f(253, 4, T.Uint32, ts(DURATION)), f(0, 1, T.Enum, 0), f(1, 1, T.Enum, 4)], 1);
for (const l of laps) {
  enc.writeMessage(
    19,
    [f(253, 4, T.Uint32, ts(l.t)), f(7, 4, T.Uint32, l.timer * 1000), f(8, 4, T.Uint32, l.timer * 1000), f(9, 4, T.Uint32, Math.round(l.d * 100))],
    3,
  );
}
enc.writeMessage(
  18,
  [f(253, 4, T.Uint32, ts(DURATION)), f(2, 4, T.Uint32, ts(0)), f(5, 1, T.Enum, 1), f(7, 4, T.Uint32, DURATION * 1000), f(8, 4, T.Uint32, DURATION * 1000), f(9, 4, T.Uint32, Math.round(dist * 100)), f(20, 2, T.Uint16, 238)],
  4,
);
writeFileSync(out, enc.close());
console.log(`${out.pathname} : ${Math.round(dist)} m`);
