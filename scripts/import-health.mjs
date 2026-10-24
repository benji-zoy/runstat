// Importe les données santé d'un export Google Takeout (« Google Health », ex-Fitbit) dans data-raw/health.json :
// FC de repos, VFC, score de préparation, sommeil, température nocturne, SpO2, fréquence respiratoire, poids.
// Seuls les dossiers utiles sont lus (pas de localisation, glycémie, etc.).
// Usage : node scripts/import-health.mjs "<chemin vers Takeout/Google Health>"
//         (le chemin est mémorisé dans data-raw/health-source.txt pour les imports suivants)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'data-raw/health-source.txt');
const src = process.argv[2] ?? (existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8').trim() : null);
if (!src || !existsSync(src)) {
  console.error('Indique le dossier « Google Health » de l’export Takeout : node scripts/import-health.mjs "<chemin>"');
  process.exit(1);
}
writeFileSync(sourceFile, src);

/** Les noms de dossiers Takeout contiennent parfois des espaces insécables : on compare en les normalisant */
function findDir(parent, name) {
  const norm = (s) => s.normalize('NFKC').replace(/ /g, ' ');
  const hit = readdirSync(parent).find((d) => norm(d) === name);
  return hit ? join(parent, hit) : null;
}

/** Lecteur CSV minimal (gère les champs entre guillemets) */
function readCsv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const split = (line) => {
    const out = [];
    let cur = '', q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (c === ',' && !q) (out.push(cur), (cur = ''));
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

const num = (v) => (v === undefined || v === '' || v === 'NaN' ? null : Number(v));
const days = {};
const day = (d) => (days[d] ??= {});
// Quand deux sources donnent la même mesure, la montre portée la nuit (Google Health App) prime
const PRIORITY = { 'Google Health App': 3, 'Google Fitbit Air': 3, 'COROS Health Connect': 2 };
const put = (date, key, value, source) => {
  if (value === null || Number.isNaN(value)) return;
  const d = day(date);
  const p = PRIORITY[source] ?? 1;
  if (d[key] === undefined || (d[`_${key}`] ?? 0) <= p) {
    d[key] = value;
    d[`_${key}`] = p;
  }
};

const pa = findDir(src, 'Physical Activity_GoogleData');
const daily = (folder, file, fn) => {
  const dir = pa && findDir(pa, folder);
  const path = dir && join(dir, file);
  if (!path || !existsSync(path)) return console.warn(`Absent : ${folder}/${file}`);
  for (const r of readCsv(path)) fn(r, r.timestamp.slice(0, 10), r['data source']);
};

daily('Daily Resting Heart Rate', 'daily_resting_heart_rate.csv', (r, d, s) => put(d, 'rhr', num(r['beats per minute']), s));
daily('Daily Heart Rate Variability', 'daily_heart_rate_variability.csv', (r, d, s) => {
  put(d, 'hrv', num(r['average heart rate variability milliseconds']), s);
  const nrem = num(r['non rem heart rate beats per minute']);
  if (nrem) put(d, 'nremHr', nrem, s);
});
daily('Daily Readiness', 'daily_readiness.csv', (r, d, s) => put(d, 'readiness', num(r.score), s));
daily('Daily Respiratory Rate', 'daily_respiratory_rate.csv', (r, d, s) => put(d, 'breath', num(r['breaths per minute']), s));
daily('Daily Sleep Temperature Derivations', 'daily_sleep_temperature_derivations.csv', (r, d, s) =>
  put(d, 'skinTemp', num(r['nightly temperature celsius']), s),
);
daily('Daily Oxygen Saturation', 'daily_oxygen_saturation.csv', (r, d, s) => put(d, 'spo2', num(r['average percentage']), s));

// Sommeil : une nuit est rattachée à la date locale du réveil ; la plus longue session est la nuit principale
const hf = findDir(src, 'Health Fitness Data_GoogleData');
if (hf) {
  const files = readdirSync(hf);
  const scores = new Map();
  for (const f of files.filter((f) => f.startsWith('UserSleepScores_'))) {
    for (const r of readCsv(join(hf, f))) scores.set(r.sleep_id, r);
  }
  // Chaque nuit est calculée par plusieurs versions de l'algorithme (sleep_session_v1, v2…) : on ne garde
  // que la plus récente disponible pour la nuit, sinon les durées s'additionnent
  const rank = (algo) => (algo?.startsWith('sleep_session_v') ? Number(algo.slice(15)) + 1 : 0);
  const sessions = files.filter((f) => f.startsWith('UserSleeps_')).flatMap((f) => readCsv(join(hf, f)));
  const nights = new Map();
  const bestRank = new Map();
  const dateOf = (r) => {
    const offset = r.end_utc_offset || '+00:00';
    const sign = offset.startsWith('-') ? -1 : 1;
    const [oh, om] = offset.slice(1).split(':').map(Number);
    return new Date(new Date(r.sleep_end).getTime() + sign * (oh * 60 + om) * 60_000).toISOString().slice(0, 10);
  };
  for (const r of sessions) bestRank.set(dateOf(r), Math.max(bestRank.get(dateOf(r)) ?? 0, rank(r.algorithm_version)));
  for (const r of sessions.filter((x) => rank(x.algorithm_version) === bestRank.get(dateOf(x)))) {
    {
      const date = dateOf(r);
      const asleep = num(r.minutes_asleep) ?? 0;
      const n = nights.get(date) ?? { total: 0, main: null };
      n.total += asleep;
      if (!n.main || asleep > n.main.asleep) n.main = { asleep, id: r.sleep_id, awake: num(r.minutes_awake), start: r.sleep_start, end: r.sleep_end };
      nights.set(date, n);
    }
  }
  for (const [date, n] of nights) {
    const d = day(date);
    d.sleepMin = n.total;
    d.sleepMain = n.main.asleep;
    d.awakeMin = n.main.awake;
    const sc = scores.get(n.main.id);
    if (sc) {
      d.sleepScore = Math.round(num(sc.overall_score) ?? 0) || null;
      d.deepMin = num(sc.deep_sleep_minutes);
      d.remPct = num(sc.rem_sleep_percent) !== null ? Math.round(num(sc.rem_sleep_percent) * 10) / 10 : null;
      d.sleepGoal = num(sc.sleep_goal_minutes);
    }
  }
} else console.warn('Absent : Health Fitness Data_GoogleData (sommeil)');

// Poids : moyenne par jour, toutes balances confondues
const weight = new Map();
daily('Weight', 'weight.csv', (r, d) => {
  const kg = num(r['weight grams']);
  if (!kg) return;
  const w = weight.get(d) ?? [];
  w.push(kg / 1000);
  weight.set(d, w);
});

// Nettoyage des marqueurs de priorité
for (const d of Object.values(days)) for (const k of Object.keys(d)) if (k.startsWith('_')) delete d[k];
const out = {
  importedAt: new Date().toISOString(),
  days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b))),
  weight: [...weight.entries()].sort().map(([date, w]) => ({ date, kg: Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 })),
};
writeFileSync(join(root, 'data-raw/health.json'), JSON.stringify(out));
const ds = Object.values(out.days);
const count = (k) => ds.filter((d) => d[k] != null).length;
console.log(
  `Santé : ${ds.length} jours (FC repos ${count('rhr')}, VFC ${count('hrv')}, préparation ${count('readiness')}, ` +
    `sommeil ${count('sleepMin')}), ${out.weight.length} pesées`,
);
