// Analyse d'une sortie seconde par seconde (FIT, ou tracé sans FIT ramené à la même structure par fit/track.ts) :
// meilleurs efforts, courbe d'allure, zones de FC, découplage, durabilité, TRIMP, allure ajustée à la pente
// (Minetti), montée / descente par durée et par tranche de pente (Runner Matrix), trace GPS simplifiée, altitude
// moyenne et caps (coût des conditions). Fonction pure : le cache (data-raw/fit-derived/) est géré par
// pipeline/build-fit.ts.
import type { FitAthlete, FitData, FitDerived } from './types.ts';

/** Version du calcul : l'incrémenter force le recalcul du cache */
export const FIT_VERSION = 5;

export const EFFORT_DISTANCES = [400, 800, 1000, 1609, 3000, 5000, 10000, 15000, 21097, 30000, 42195];
export const CURVE_DURATIONS = [30, 60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800];
/** Durées de la Runner Matrix (meilleur D+ / D− cumulé) */
export const VERT_DURATIONS = [300, 1200, 3600, 7200, 10800];
/** Bornes des tranches de pente : < −15 %, −15/−8, −8/−3, plat ±3 %, 3/8, 8/15, > 15 % */
export const GRADE_EDGES = [-0.15, -0.08, -0.03, 0.03, 0.08, 0.15];

/** Coût énergétique de la course selon la pente (Minetti et al. 2002), J/kg/m */
export function minetti(i: number): number {
  const g = Math.max(-0.45, Math.min(0.45, i));
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

/** Temps minimal (s) pour couvrir `target` mètres, fenêtre glissante avec interpolation */
export function bestTime(dist: number[], time: number[], target: number): number | null {
  let best = Infinity;
  let i = 0;
  for (let j = 1; j < dist.length; j++) {
    while (i + 1 < j && dist[j] - dist[i + 1] >= target) i++;
    const d = dist[j] - dist[i];
    if (d < target) continue;
    // On retire au début l'excédent de distance, au prorata de la vitesse du premier segment
    const segD = dist[i + 1] - dist[i];
    const segT = time[i + 1] - time[i];
    const extra = d - target;
    const t = time[j] - time[i] - (segD > 0 ? (extra / segD) * segT : 0);
    if (t > 0 && t < best) best = t;
  }
  return isFinite(best) ? Math.round(best) : null;
}

/** Distance maximale (m) couverte en `duration` secondes */
export function bestDistance(dist: number[], time: number[], duration: number): number | null {
  let best = 0;
  let i = 0;
  for (let j = 1; j < dist.length; j++) {
    while (i + 1 < j && time[j] - time[i + 1] >= duration) i++;
    const t = time[j] - time[i];
    if (t < duration) continue;
    const d = ((dist[j] - dist[i]) * duration) / t;
    if (d > best) best = d;
  }
  return best > 0 ? Math.round(best) : null;
}

/** Plus grande valeur d'un cumul (D+, D−) gagnée en `duration` secondes, fenêtre glissante */
export function bestGain(cum: number[], time: number[], duration: number): number | null {
  let best = 0;
  let i = 0;
  for (let j = 1; j < cum.length; j++) {
    while (i + 1 < j && time[j] - time[i + 1] >= duration) i++;
    if (time[j] - time[i] < duration) continue;
    best = Math.max(best, cum[j] - cum[i]);
  }
  return time[cum.length - 1] >= duration ? Math.round(best) : null;
}

/** Encodage « polyline » de Google (précision 1e-5) */
export function encodePolyline(points: [number, number][]): string {
  let out = '';
  let pLat = 0, pLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

/** Premier point d'une polyline Google (précision 1e-5) */
export function firstPoint(poly: string): [number, number] | null {
  const vals: number[] = [];
  let i = 0;
  while (vals.length < 2 && i < poly.length) {
    let shift = 0, n = 0, b: number;
    do (b = poly.charCodeAt(i++) - 63), (n |= (b & 0x1f) << shift), (shift += 5);
    while (b >= 0x20);
    vals.push((n & 1 ? ~(n >> 1) : n >> 1) / 1e5);
  }
  return vals.length === 2 ? [vals[0], vals[1]] : null;
}

/** Enregistrement retenu : distance et chronomètre présents */
type TimedRecord = NonNullable<FitData['records']>[number] & { distance: number; timer_time: number };

export function analyse(data: FitData, athlete: FitAthlete): FitDerived | null {
  const recs = (data.records ?? []).filter((r): r is TimedRecord => r.distance != null && r.timer_time != null);
  if (recs.length < 30) return null;
  const n = recs.length;
  const time = recs.map((r) => r.timer_time);
  const dist = recs.map((r) => r.distance);
  const hr = recs.map((r) => r.heart_rate ?? null);

  // Altitude lissée (moyenne glissante 15 points) puis distance « équivalent plat » de Minetti
  const altRaw: (number | null)[] = recs.map((r) => r.enhanced_altitude ?? r.altitude ?? null);
  const hasAlt = altRaw.filter((a) => a != null).length > n * 0.8;
  // Altitude absente au début ou à la fin (capteur pas encore prêt) : on prolonge la première / dernière valeur
  const firstAlt = altRaw.find((a) => a != null);
  let lastAlt: number | null = null;
  for (let k = n - 1; k >= 0 && lastAlt == null; k--) lastAlt = altRaw[k];
  for (let k = 0; k < n && altRaw[k] == null; k++) altRaw[k] = firstAlt ?? null;
  for (let k = n - 1; k >= 0 && altRaw[k] == null; k--) altRaw[k] = lastAlt;
  const alt = altRaw.map((_, k) => {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - 7); q <= Math.min(n - 1, k + 7); q++) {
      const a = altRaw[q];
      if (a != null) (s += a), c++;
    }
    return c ? s / c : 0;
  });
  const gapDist = new Array<number>(n).fill(0);
  let anchor = 0;
  for (let k = 1; k < n; k++) {
    gapDist[k] = gapDist[k - 1];
    const dd = dist[k] - dist[k - 1];
    if (dd <= 0) continue;
    // Pente calculée sur au moins 20 m pour limiter le bruit
    while (anchor < k - 1 && dist[k] - dist[anchor + 1] >= 20) anchor++;
    const span = dist[k] - dist[anchor];
    const grade = hasAlt && span >= 20 ? (alt[k] - alt[anchor]) / span : 0;
    gapDist[k] += (dd * minetti(grade)) / minetti(0);
  }

  const efforts: Record<string, number | null> = {};
  const effortsGap: Record<string, number | null> = {};
  for (const d of EFFORT_DISTANCES) {
    if (dist[n - 1] < d) continue;
    efforts[d] = bestTime(dist, time, d);
    if (hasAlt && gapDist[n - 1] >= d) effortsGap[d] = bestTime(gapDist, time, d);
  }
  const curve: Record<string, number | null> = {};
  const curveGap: Record<string, number | null> = {};
  for (const s of CURVE_DURATIONS) {
    if (time[n - 1] < s) continue;
    curve[s] = bestDistance(dist, time, s);
    if (hasAlt) curveGap[s] = bestDistance(gapDist, time, s);
  }

  // Montée / descente : D+ et D− cumulés (altitude lissée), meilleur gain par durée ; temps, distances et FC par
  // tranche de pente, la pente étant mesurée sur ±30 m autour de chaque point (hors arrêts : < 0,3 m/s)
  let climb: Record<string, number | null> | null = null;
  let descent: Record<string, number | null> | null = null;
  let terrain: number[][] | null = null;
  if (hasAlt) {
    // Hystérésis de 1 m contre le bruit de l'altimètre (D+ médian = D+ Coros à 1 % près sur route, 5 % en trail)
    const upCum = new Array<number>(n).fill(0), downCum = new Array<number>(n).fill(0);
    let anchorAlt = alt[0];
    for (let k = 1; k < n; k++) {
      upCum[k] = upCum[k - 1];
      downCum[k] = downCum[k - 1];
      // Saut d'altitude impossible à pied (> 1 m/s) : ignoré
      if (Math.abs(alt[k] - alt[k - 1]) > Math.max(1, time[k] - time[k - 1])) anchorAlt += alt[k] - alt[k - 1];
      const dz = alt[k] - anchorAlt;
      if (Math.abs(dz) < 1) continue;
      if (dz > 0) upCum[k] += dz;
      else downCum[k] -= dz;
      anchorAlt = alt[k];
    }
    climb = {};
    descent = {};
    for (const s of VERT_DURATIONS) {
      if (time[n - 1] < s) continue;
      climb[s] = bestGain(upCum, time, s);
      descent[s] = bestGain(downCum, time, s);
    }
    // [secondes, distance m, distance ajustée m, D+ m, D− m, secondes avec FC, somme FC × s]
    const bins = Array.from({ length: GRADE_EDGES.length + 1 }, () => [0, 0, 0, 0, 0, 0, 0]);
    let lo = 0, hi = 0;
    for (let k = 1; k < n; k++) {
      while (dist[k] - dist[lo] > 30) lo++;
      while (hi + 1 < n && dist[hi + 1] - dist[k] <= 30) hi++;
      const dt = time[k] - time[k - 1];
      const dd = dist[k] - dist[k - 1];
      const span = dist[hi] - dist[lo];
      if (dt <= 0 || dt > 10 || dd < 0.3 * dt || span < 40) continue;
      const g = (alt[hi] - alt[lo]) / span;
      const b = bins[GRADE_EDGES.filter((e) => g >= e).length];
      const dz = alt[k] - alt[k - 1];
      const h = hr[k];
      b[0] += dt;
      b[1] += dd;
      b[2] += gapDist[k] - gapDist[k - 1];
      b[3] += Math.max(0, dz);
      b[4] += Math.max(0, -dz);
      if (h) (b[5] += dt), (b[6] += h * dt);
    }
    terrain = bins.map((b) => b.map(Math.round));
  }

  // FC : max, zones (5 zones % FCmax + 3 zones de Seiler), TRIMP de Banister seconde par seconde
  const { hrMax, hrRest } = athlete;
  const lt1 = athlete.lt1Hr ?? Math.round(0.8 * hrMax);
  const lt2 = athlete.lt2Hr ?? Math.round(0.89 * hrMax);
  const zones5 = [0, 0, 0, 0, 0];
  const zones3 = [0, 0, 0];
  let trimp = 0, maxHr = 0;
  for (let k = 1; k < n; k++) {
    const h = hr[k];
    const dt = Math.min(10, time[k] - time[k - 1]);
    if (!h || dt <= 0) continue;
    maxHr = Math.max(maxHr, h);
    const pct = h / hrMax;
    zones5[pct < 0.6 ? 0 : pct < 0.7 ? 1 : pct < 0.8 ? 2 : pct < 0.9 ? 3 : 4] += dt;
    zones3[h < lt1 ? 0 : h < lt2 ? 1 : 2] += dt;
    const hrr = Math.max(0, Math.min(1, (h - hrRest) / (hrMax - hrRest)));
    trimp += (dt / 60) * hrr * 0.64 * Math.exp(1.92 * hrr);
  }

  // Efficacité (vitesse ajustée à la pente / FC) par blocs, pour le découplage et la durabilité
  const efBetween = (t0: number, t1: number) => {
    let d = 0, s = 0, hSum = 0, hN = 0;
    for (let k = 1; k < n; k++) {
      if (time[k] <= t0 || time[k] > t1) continue;
      d += gapDist[k] - gapDist[k - 1];
      s += time[k] - time[k - 1];
      const h = hr[k];
      if (h) (hSum += h), hN++;
    }
    return s > 60 && hN ? (d / s) * 60 / (hSum / hN) : null;
  };
  const total = time[n - 1];
  let decoupling: number | null = null;
  if (total >= 40 * 60) {
    // On ignore les 10 premières minutes (échauffement), puis on compare les deux moitiés
    const start = 600;
    const mid = start + (total - start) / 2;
    const ef1 = efBetween(start, mid);
    const ef2 = efBetween(mid, total);
    if (ef1 && ef2) decoupling = Math.round(((ef1 - ef2) / ef1) * 1000) / 10;
  }
  let durability: (number | null)[] | null = null;
  if (total >= 75 * 60) {
    // EF par blocs de 15 min, rapportée au bloc 15-30 min
    const blocks: (number | null)[] = [];
    for (let t0 = 0; t0 + 900 <= total; t0 += 900) blocks.push(efBetween(t0, t0 + 900));
    const ref = blocks[1];
    if (ref) durability = blocks.map((b) => (b ? Math.round((b / ref) * 1000) / 1000 : null));
  }

  // Régularité des tours : coefficient de variation de la vitesse des tours ≥ 200 m
  const laps = (data.laps ?? []).filter((l) => (l.total_distance ?? 0) >= 200 && (l.total_timer_time ?? 0) > 0);
  const lapSpeeds = laps.map((l) => l.total_distance! / l.total_timer_time!);
  let lapCv: number | null = null;
  if (lapSpeeds.length >= 3) {
    const m = lapSpeeds.reduce((a, b) => a + b, 0) / lapSpeeds.length;
    const sd = Math.sqrt(lapSpeeds.reduce((a, b) => a + (b - m) ** 2, 0) / lapSpeeds.length);
    lapCv = Math.round((sd / m) * 1000) / 1000;
  }

  // Temps de chaque kilomètre complet (interpolé au passage de chaque borne)
  const splits: number[] = [];
  let nextKm = 1000, lastT = time[0];
  for (let k = 1; k < n && nextKm <= dist[n - 1]; k++) {
    while (dist[k] >= nextKm) {
      const f = (nextKm - dist[k - 1]) / Math.max(1e-6, dist[k] - dist[k - 1]);
      const t = time[k - 1] + f * (time[k] - time[k - 1]);
      splits.push(Math.round((t - lastT) * 10) / 10);
      lastT = t;
      nextKm += 1000;
    }
  }

  // Tours au km, même format que les tours Coros (data-raw/laps) : [d, t, fc, D+, D−, allure ajustée, puissance, cadence]
  // L'allure ajustée est l'« Effort Pace » Coros si présent (comme dans les tours de l'appli), sinon Minetti.
  const effort = recs.map((r) => r['Effort Pace'] ?? null);
  const hasEffort = effort.filter((x) => x).length > n * 0.5;
  const km: number[][] = [];
  let k0 = 0;
  const closeLap = (k1: number) => {
    const t = time[k1] - time[k0];
    const d = dist[k1] - dist[k0];
    if (t <= 0 || d <= 0) return;
    let hrS = 0, hrT = 0, pwS = 0, pwT = 0, cadS = 0, cadT = 0, effS = 0, effT = 0, up = 0, down = 0;
    for (let q = k0 + 1; q <= k1; q++) {
      const dt = Math.min(10, time[q] - time[q - 1]);
      if (dt <= 0) continue;
      const r = recs[q];
      const e = effort[q];
      if (r.heart_rate) (hrS += r.heart_rate * dt), (hrT += dt);
      if (r.power) (pwS += r.power * dt), (pwT += dt);
      if (r.cadence) (cadS += r.cadence * 2 * dt), (cadT += dt);
      if (e) (effS += e * dt), (effT += dt);
      const dz = alt[q] - alt[q - 1];
      if (hasAlt) dz > 0 ? (up += dz) : (down -= dz);
    }
    const gapPace = hasEffort && effT ? 1000 / (effS / effT) : (t / Math.max(1, gapDist[k1] - gapDist[k0])) * 1000;
    km.push([
      Math.round(d), Math.round(t * 10) / 10, hrT ? Math.round(hrS / hrT) : 0, Math.round(up), Math.round(down),
      Math.round(gapPace), pwT ? Math.round(pwS / pwT) : 0, cadT ? Math.round(cadS / cadT) : 0,
    ]);
  };
  for (let k = 1; k < n; k++) {
    if (dist[k] - dist[k0] >= 1000) {
      closeLap(k);
      k0 = k;
    }
  }
  if (dist[n - 1] - dist[k0] >= 100) closeLap(n - 1);

  // Trace GPS simplifiée : un point tous les 40 m
  const pts: [number, number][] = [];
  let lastD = -Infinity;
  for (const r of recs) {
    if (r.position_lat == null || r.position_long == null) continue;
    if (r.distance - lastD >= 40) {
      pts.push([r.position_lat, r.position_long]);
      lastD = r.distance;
    }
  }

  // Caps (coût du vent) : 16 secteurs de 22,5° depuis le nord, [secondes, mètres] sur des tronçons GPS d'environ
  // 200 m ; les arrêts (> 10 s entre deux points) ne comptent pas.
  let headings: number[][] | null = null;
  type GeoRecord = TimedRecord & { position_lat: number; position_long: number };
  const geo = recs.filter((r): r is GeoRecord => r.position_lat != null && r.position_long != null);
  if (geo.length >= 30) {
    const sectors = Array.from({ length: 16 }, () => [0, 0]);
    let a = geo[0];
    let moving = 0;
    for (let q = 1; q < geo.length; q++) {
      const dt = geo[q].timer_time - geo[q - 1].timer_time;
      if (dt > 0 && dt <= 10) moving += dt;
      const dd = geo[q].distance - a.distance;
      if (dd < 200 && q < geo.length - 1) continue;
      const rad = Math.PI / 180;
      const y = Math.sin((geo[q].position_long - a.position_long) * rad) * Math.cos(geo[q].position_lat * rad);
      const x =
        Math.cos(a.position_lat * rad) * Math.sin(geo[q].position_lat * rad) -
        Math.sin(a.position_lat * rad) * Math.cos(geo[q].position_lat * rad) * Math.cos((geo[q].position_long - a.position_long) * rad);
      if (dd > 0 && moving > 0 && (x || y)) {
        const bearing = ((Math.atan2(y, x) / rad) + 360) % 360;
        const s = Math.round(bearing / 22.5) % 16;
        sectors[s][0] += moving;
        sectors[s][1] += dd;
      }
      a = geo[q];
      moving = 0;
    }
    headings = sectors.map(([t, d]) => [Math.round(t), Math.round(d)]);
    if (!headings.some(([t]) => t > 0)) headings = null;
  }

  // Altitude moyenne pondérée par le temps (altitude : manque d'oxygène)
  let altMean: number | null = null;
  if (hasAlt) {
    let s = 0, c = 0;
    for (let k = 1; k < n; k++) {
      const dt = Math.min(10, time[k] - time[k - 1]);
      if (dt > 0) (s += alt[k] * dt), (c += dt);
    }
    if (c) altMean = Math.round(s / c);
  }

  const temps = recs.map((r) => r.temperature).filter((t): t is number => t != null);
  const session = data.sessions?.[0] ?? {};
  return {
    v: FIT_VERSION,
    duration: Math.round(total),
    distance: Math.round(dist[n - 1]),
    gapDistance: Math.round(gapDist[n - 1]),
    maxHr: maxHr || null,
    lt: [lt1, lt2],
    zones5: zones5.map(Math.round),
    zones3: zones3.map(Math.round),
    trimp: Math.round(trimp),
    efforts,
    effortsGap,
    curve,
    curveGap,
    climb,
    descent,
    terrain,
    decoupling,
    durability,
    lapCount: laps.length,
    lapCv,
    sensorTemp: temps.length ? Math.round(temps.reduce((a, b) => a + b, 0) / temps.length) : null,
    avgPower: session.avg_power ?? null,
    splits,
    km,
    route: pts.length >= 2 ? encodePolyline(pts) : null,
    altMean,
    headings,
  };
}
