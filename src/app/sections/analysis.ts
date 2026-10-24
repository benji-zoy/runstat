import { Component, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ChartConfiguration } from 'chart.js';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import {
  SESSION_TYPES, SessionType, acwr, bestEfforts, dailyLoads, efSeries, foster, heatAdjustedPace, heatPenalty, marathonShape,
  officialDistance, polarizationIndex, riegel, tanda, wallAnalysis, theilSen, timeForVdot, trimp, vdot, vickers, vo2maxCurve,
} from '../core/science';
import { addDays, isoDay, monthly, parseDay, startOfWeek, weekly } from '../core/stats';
import { freshnessState, pmc } from '../core/insights';
import { clock, day, fixed, num, pace } from '../core/format';
import { durabilitySummary } from '../core/durability';
import { ChartComponent } from '../ui/chart';
import { BriefComponent } from '../ui/brief';
import { C, alpha } from '../ui/palette';
import { RunnerMatrixSection } from '../sections/runner-matrix';
import { worldLevel } from '../core/matrix';

const DISTANCES = [
  { key: '5K', m: 5000 },
  { key: '10K', m: 10000 },
  { key: 'Semi', m: 21097 },
  { key: 'Marathon', m: 42195 },
];
const EFFORT_LABELS: Record<number, string> = {
  400: '400 m', 800: '800 m', 1000: '1 km', 1609: '1 mile', 3000: '3 km', 5000: '5 km', 10000: '10 km',
  15000: '15 km', 21097: 'Semi', 30000: '30 km', 42195: 'Marathon',
};
const short = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/** Focus de séance Coros */
const FOCUS: Record<string, string> = {
  Recovery: 'Récupération',
  Base: 'Endurance de base',
  Tempo: 'Tempo',
  Threshold: 'Seuil',
  'VO2 Max': 'VO2max',
  Anaerobic: 'Anaérobie',
};

/** Traduction des commentaires de charge Coros, avec un statut visuel. */
const LOAD_STATUS: Record<string, { label: string; tone: 'good' | 'neutral' | 'warning' | 'serious' | 'critical' }> = {
  Optimized: { label: 'Optimale', tone: 'good' },
  Maintaining: { label: 'Maintien', tone: 'neutral' },
  Recovery: { label: 'Récupération', tone: 'neutral' },
  Low: { label: 'Faible', tone: 'warning' },
  Insufficient: { label: 'Insuffisante', tone: 'warning' },
  High: { label: 'Élevée', tone: 'serious' },
  Excessive: { label: 'Excessive', tone: 'critical' },
};

/**
 * Vues d'analyse, chacune rangée dans l'espace qui répond à sa question :
 * Performance › Potentiel, Profil, Durabilité ; Forme › Charge, Efficacité ; Entraînement › Séances.
 */
export type AnalysisView = 'predictions' | 'matrice' | 'efficacite' | 'durabilite' | 'charge' | 'seances';
const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: '2-digit' });

@Component({
  selector: 'app-analysis',
  imports: [ChartComponent, DecimalPipe, RunnerMatrixSection, BriefComponent],
  templateUrl: './analysis.html',
  styleUrl: './analysis.scss',
})
export class AnalysisSection {
  readonly view = input.required<AnalysisView>();

  protected readonly store = inject(DataService);
  private readonly today = inject(PeriodService).today;
  protected readonly sci = inject(ScienceService);


  protected readonly clock = clock;
  protected readonly pace = pace;
  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly types = SESSION_TYPES;
  protected readonly Math = Math;
  protected readonly vdot = vdot;
  protected fmt = (iso: string) => day(parseDay(iso));
  protected fmtDate = (d: Date) => day(d);
  protected effortLabel = (m: number) => EFFORT_LABELS[m] ?? `${m} m`;

  private readonly acts = this.store.activities;
  protected readonly ath = this.sci.athlete;

  // -------------------------------------------------------------------------
  // Prédictions
  // -------------------------------------------------------------------------

  protected readonly fitness = computed(() => this.store.data()?.fitness ?? null);
  protected readonly best = computed(() => this.sci.references()[0] ?? null);
  private readonly tandaRes = computed(() => tanda(this.acts(), this.today));
  protected readonly lastMarathon = computed(() => {
    const a = [...this.acts()].reverse().find((x) => this.sci.types().get(x.id) === 'race' && x.distanceKm >= 40);
    return a ? { a, wall: wallAnalysis(a) } : null;
  });

  protected readonly predictions = computed(() => {
    const ref = this.best();
    const coros = this.store.data()?.fitness?.predictions ?? {};
    const k = this.sci.exponent()?.k ?? null;
    const cs = this.sci.criticalSpeed();
    const t = this.tandaRes();
    const toSec = (s: string | null | undefined) => (s ? s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0) : null);
    return DISTANCES.map((d) => ({
      key: d.key,
      coros: toSec(coros[d.key]),
      vdot: ref ? timeForVdot(ref.vdot, d.m) : null,
      riegel: ref ? riegel(ref.time, ref.dist, d.m) : null,
      // L'exposant personnel est mesuré vers les longues distances : on ne l'extrapole pas vers le bas
      riegelPerso: ref && k && d.m > ref.dist ? riegel(ref.time, ref.dist, d.m, k) : null,
      // Vitesse critique : t = (d − D′)/CS jusqu'au 10 km ; marathon couru à ~85 % de CS (Smyth 2020)
      cs: cs ? (d.m <= 10000 ? (d.m - cs.dPrime) / cs.cs : d.m === 42195 ? d.m / (0.85 * cs.cs) : null) : null,
      vickers: ref && t && d.m === 42195 ? vickers(ref.time, ref.dist, t.kmPerWeek) : null,
      tanda: t && d.m === 42195 ? t.seconds : null,
    }));
  });

  protected readonly shape = computed(() => {
    const ref = this.best();
    return ref ? marathonShape(this.acts(), ref.vdot, this.today) : null;
  });

  // -------------------------------------------------------------------------
  // Vitesse critique & courbe d'allure
  // -------------------------------------------------------------------------

  protected readonly csChart = computed<ChartConfiguration>(() => {
    const cs = this.sci.criticalSpeed();
    const pts = cs?.points ?? [];
    const maxT = Math.max(1500, ...pts.map((p) => p.time));
    return {
      type: 'scatter',
      data: {
        datasets: [
          {
            type: 'scatter',
            label: 'Meilleurs efforts (16 sem.)',
            data: pts.map((p) => ({ x: p.time / 60, y: p.dist })),
            backgroundColor: C.accent,
            pointRadius: 6,
            pointHoverRadius: 8,
          },
          ...(cs
            ? [
                {
                  type: 'line' as const,
                  label: `Modèle : d = ${num(cs.cs, 2)}·t + ${num(cs.dPrime)}`,
                  data: [0, maxT].map((t) => ({ x: t / 60, y: cs.cs * t + cs.dPrime })),
                  borderColor: C.s1,
                  borderWidth: 2,
                  pointRadius: 0,
                },
              ]
            : []),
        ],
      },
      options: {
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Durée (min)' }, beginAtZero: true },
          y: { title: { display: true, text: 'Distance (m)' }, beginAtZero: true },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => ` ${num(c.parsed.y ?? 0)} m en ${clock((c.parsed.x ?? 0) * 60)}` } },
        },
      },
    };
  });

  protected readonly curveChart = computed<ChartConfiguration>(() => {
    const durations = [60, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800];
    const bestFor = (days: number | null) =>
      durations.map((s) => {
        let best = 0;
        for (const a of this.acts()) {
          if (!a.fit || a.kind === 'indoor') continue;
          if (days !== null && (this.today.getTime() - parseDay(a.date).getTime()) / 86_400_000 > days) continue;
          best = Math.max(best, a.fit.curve[s] ?? 0);
        }
        return best ? Math.round(s / (best / 1000)) : null;
      });
    const label = (s: number) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`);
    return {
      type: 'line',
      data: {
        labels: durations.map(label),
        datasets: [
          { label: '6 dernières semaines', data: bestFor(42), borderColor: C.accent, backgroundColor: C.accent, borderWidth: 2, pointRadius: 3, spanGaps: true },
          { label: 'Tous les fichiers FIT', data: bestFor(null), borderColor: C.s1, backgroundColor: C.s1, borderWidth: 2, pointRadius: 3, spanGaps: true },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false } },
          y: { reverse: true, ticks: { callback: (v) => pace(Number(v)) }, title: { display: true, text: 'Meilleure allure (min/km)' } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${pace(c.parsed.y)} /km` } },
        },
      },
    };
  });

  /** Allures d'entraînement dérivées de la vitesse critique */
  protected readonly csZones = computed(() => {
    const cs = this.sci.criticalSpeed()?.cs;
    if (!cs) return [];
    const p = (f: number) => pace(1000 / (cs * f));
    return [
      { label: 'Endurance fondamentale', range: `${p(0.7)} – ${p(0.8)}`, note: '70–80 % de CS' },
      { label: 'Allure marathon', range: `${p(0.82)} – ${p(0.88)}`, note: '≈ 85 % de CS (Smyth 2020)' },
      { label: 'Allure semi', range: `${p(0.9)} – ${p(0.94)}`, note: 'au-delà de 94 %, risque d’effondrement' },
      { label: 'Seuil', range: `${p(0.95)} – ${p(1)}`, note: 'juste sous CS' },
      { label: 'Fractionné long (3–8 min)', range: `${p(1.03)} – ${p(1.08)}`, note: 'au-dessus de CS, puise dans D′' },
    ];
  });

  // -------------------------------------------------------------------------
  // Indice de forme & efficacité
  // -------------------------------------------------------------------------

  private readonly formCurve = computed(() => vo2maxCurve(this.acts(), this.ath(), this.today));
  protected readonly formNow = computed(() => this.formCurve().at(-1)?.value ?? null);
  protected readonly formTrend = computed(() => {
    const c = this.formCurve().filter((p) => (this.today.getTime() - p.date.getTime()) / 86_400_000 <= 182);
    return c.length > 4 ? theilSen(c.map((p) => ({ x: p.date.getTime() / 86_400_000, y: p.value }))) * 30 : null;
  });

  protected readonly formChart = computed<ChartConfiguration>(() => {
    const curve = this.formCurve();
    const races = this.acts().filter((a) => this.sci.types().get(a.id) === 'race' && a.kind === 'road' && a.distanceKm >= 3);
    return {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Indice de forme FC/allure (30 j)',
            data: curve.map((p) => ({ x: p.date.getTime(), y: Math.round(p.value * 10) / 10 })),
            borderColor: C.s1,
            backgroundColor: C.s1,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
          },
          {
            type: 'scatter',
            label: 'VDOT des courses sur route',
            data: races.map((a) => {
              const w = wallAnalysis(a);
              const time = w?.wall && w.potential ? w.potential : a.durationSec;
              return {
                x: parseDay(a.date).getTime(),
                y: Math.round(vdot(officialDistance(a.distanceKm), time) * 10) / 10,
                name: w?.wall ? `${a.name} (temps potentiel sans le mur)` : a.name,
              };
            }),
            backgroundColor: races.map((a) => (wallAnalysis(a)?.wall ? 'transparent' : C.accent)),
            borderColor: C.accent,
            borderWidth: 2,
            pointRadius: 6,
            pointHoverRadius: 8,
          },
        ],
      },
      options: {
        scales: {
          x: { type: 'linear', ticks: { callback: (v) => monthFmt.format(new Date(Number(v))), maxTicksLimit: 10 }, grid: { display: false } },
          y: { title: { display: true, text: 'ml/kg/min' } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (i) => day(new Date(i[0].parsed.x ?? 0)),
              label: (c) => {
                const raw = c.raw as { name?: string };
                return ` ${raw.name ? raw.name + ' · ' : ''}${num(c.parsed.y ?? 0, 1)}`;
              },
            },
          },
        },
      },
    };
  });

  protected readonly ef = computed(() => efSeries(this.acts(), this.sci.types()));
  protected readonly efTrend = computed(() => {
    const pts = this.ef().filter((p) => (this.today.getTime() - parseDay(p.activity.date).getTime()) / 86_400_000 <= 365);
    if (pts.length < 6) return null;
    const slope = theilSen(pts.map((p) => ({ x: parseDay(p.activity.date).getTime() / 86_400_000, y: p.ef })));
    const mean = pts.reduce((s, p) => s + p.ef, 0) / pts.length;
    return (slope * 91) / mean * 100;
  });
  protected readonly anomalies = computed(() => this.ef().filter((p) => p.z < -2.5).reverse().slice(0, 8));

  protected readonly efChart = computed<ChartConfiguration>(() => {
    const pts = this.ef();
    const normal = pts.filter((p) => p.z >= -2.5);
    const odd = pts.filter((p) => p.z < -2.5);
    const toPt = (p: (typeof pts)[number]) => ({ x: parseDay(p.activity.date).getTime(), y: Math.round(p.ef * 1000) / 1000, name: p.activity.name });
    return {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Sortie d’endurance', data: normal.map(toPt), backgroundColor: alpha(C.s1, 0.7), pointRadius: 3.5 },
          { label: 'FC anormalement haute', data: odd.map(toPt), backgroundColor: C.bad, pointRadius: 6 },
          {
            type: 'line',
            label: 'Référence (médiane des 15 précédentes)',
            data: pts.map((p) => ({ x: parseDay(p.activity.date).getTime(), y: Math.round(p.baseline * 1000) / 1000 })),
            borderColor: C.neutral,
            borderWidth: 1.5,
            pointRadius: 0,
          },
        ],
      },
      options: {
        scales: {
          x: { type: 'linear', ticks: { callback: (v) => monthFmt.format(new Date(Number(v))), maxTicksLimit: 10 }, grid: { display: false } },
          y: { title: { display: true, text: 'm/min par battement' } },
        },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (i) => day(new Date(i[0].parsed.x ?? 0)),
              label: (c) => {
                const raw = c.raw as { name?: string };
                return ` ${raw.name ?? c.dataset.label} : ${num(c.parsed.y ?? 0, 3)}`;
              },
            },
          },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Endurance : découplage & durabilité (FIT)
  // -------------------------------------------------------------------------

  protected readonly decoupled = computed(() =>
    this.acts()
      .filter((a) => a.fit?.decoupling != null && ['easy', 'long', 'recovery'].includes(this.sci.types().get(a.id) ?? ''))
      .slice(-20),
  );

  protected readonly decouplingChart = computed<ChartConfiguration>(() => {
    const runs = this.decoupled();
    const color = (d: number) => (d < 5 ? C.s1 : d < 10 ? C.amber : C.bad);
    return {
      type: 'bar',
      data: {
        labels: runs.map((a) => short.format(parseDay(a.date))),
        datasets: [
          {
            label: 'Découplage',
            data: runs.map((a) => a.fit!.decoupling!),
            backgroundColor: runs.map((a) => color(a.fit!.decoupling!)),
            borderRadius: 4,
          },
        ],
      },
      options: {
        scales: { x: { grid: { display: false } }, y: { title: { display: true, text: '%' } } },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (i) => runs[i[0].dataIndex].name,
              label: (c) => ` ${num(c.parsed.y ?? 0, 1)} % · ${num(runs[c.dataIndex].distanceKm, 1)} km en ${clock(runs[c.dataIndex].durationSec)}`,
            },
          },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Durabilité (tours au km : FIT ou tours Coros)
  // -------------------------------------------------------------------------

  protected readonly dur = computed(() =>
    durabilitySummary(this.acts(), this.today, 365, (a) => ['interval', 'tempo'].includes(this.sci.types().get(a.id) ?? '')),
  );
  protected readonly durTrail = computed(() => this.dur().runs.filter((r) => r.trail && r.hours >= 1).slice().reverse());
  protected readonly durOnset = computed(() => {
    const long = this.dur().runs.filter((r) => r.hours >= 1.5);
    const onsets = long.map((r) => r.onset).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return { held: long.length - onsets.length, total: long.length, median: onsets.length ? onsets[onsets.length >> 1] : null };
  });
  protected readonly hm = (sec: number) => `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`;
  protected readonly signed = (x: number, d: 0 | 1 = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${num(Math.abs(x), d)}`;

  protected readonly durCurveChart = computed<ChartConfiguration>(() => {
    const { road, trail } = this.dur().curve;
    const len = Math.max(road.length, trail.length);
    const pct = (xs: (number | null)[]) => Array.from({ length: len }, (_, i) => (xs[i] != null ? Math.round(xs[i]! * 1000) / 10 : null));
    return {
      type: 'line',
      data: {
        labels: Array.from({ length: len }, (_, i) => `${i + 1}${i ? 'e' : 're'} h`),
        datasets: [
          { label: 'Route', data: pct(road), borderColor: C.s1, backgroundColor: C.s1, borderWidth: 2, pointRadius: 4, tension: 0.25, spanGaps: true },
          { label: 'Trail', data: pct(trail), borderColor: C.s3, backgroundColor: C.s3, borderWidth: 2, pointRadius: 4, tension: 0.25, spanGaps: true },
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false } }, y: { title: { display: true, text: 'Efficacité (% du 1er tiers)' }, suggestedMin: 85, suggestedMax: 102 } },
        plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${num(c.parsed.y ?? 0, 1)} %` } } },
      },
    };
  });

  protected readonly durScatterChart = computed<ChartConfiguration>(() => {
    const d = this.dur();
    const set = (trail: boolean, color: string, label: string) => {
      const rs = d.runs.filter((r) => r.trail === trail);
      const g = trail ? d.trail : d.road;
      const xs = rs.map((r) => r.hours);
      const line = g && rs.length >= 3
        ? (() => {
            const b = [...rs.map((r) => r.efLoss - g.perHour * r.hours)].sort((x, y) => x - y)[rs.length >> 1];
            const [lo, hi] = [Math.min(...xs), Math.max(...xs)];
            return [{ x: lo, y: b + g.perHour * lo }, { x: hi, y: b + g.perHour * hi }];
          })()
        : null;
      return [
        {
          type: 'scatter' as const,
          label,
          data: rs.map((r) => ({ x: Math.round(r.hours * 100) / 100, y: Math.round(r.efLoss * 10) / 10, name: `${r.activity.name} (${short.format(parseDay(r.activity.date))})` })),
          backgroundColor: color,
          borderColor: C.surface,
          borderWidth: 1.5,
          pointRadius: 6,
          pointHoverRadius: 8,
        },
        ...(line ? [{ type: 'line' as const, label: `${label} (tendance)`, data: line, borderColor: color, borderDash: [5, 4], borderWidth: 2, pointRadius: 0 }] : []),
      ];
    };
    return {
      type: 'scatter',
      data: { datasets: [...set(false, C.s1, 'Route'), ...set(true, C.s3, 'Trail')] },
      options: {
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Durée (h)' } },
          y: { title: { display: true, text: 'Perte d\'efficacité (%)' } },
        },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { filter: (i) => !i.text.includes('tendance') } },
          tooltip: {
            filter: (i) => !String(i.dataset.label).includes('tendance'),
            callbacks: { label: (c) => ` ${(c.raw as { name: string }).name} : ${num(c.parsed.y ?? 0, 1)} % en ${this.hm((c.parsed.x ?? 0) * 3600)}` },
          },
        },
      },
    };
  });

  protected readonly durProfilesChart = computed<ChartConfiguration>(() => {
    const runs = this.dur().runs.filter((r) => r.hours >= 1.5).slice(-4);
    const colors = [C.s1, C.s2, C.s3, C.s4];
    return {
      type: 'line',
      data: {
        datasets: runs.map((r, i) => ({
          label: `${short.format(parseDay(r.activity.date))} · ${r.activity.name}`,
          data: r.profile.map((p) => ({ x: Math.round((p.t / 3600) * 100) / 100, y: Math.round(p.rel * 1000) / 10 })),
          borderColor: colors[i],
          backgroundColor: colors[i],
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        })),
      },
      options: {
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Temps écoulé (h)' } },
          y: { title: { display: true, text: 'Efficacité (% du 1er tiers)' } },
        },
        plugins: {
          legend: { position: 'top', align: 'start' },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${num(c.parsed.y ?? 0, 1)} % à ${this.hm((c.parsed.x ?? 0) * 3600)}` } },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Intensité (FIT) et charge
  // -------------------------------------------------------------------------

  protected readonly zonesByMonth = computed(() => {
    const months = new Map<string, number[]>();
    for (const a of this.acts()) {
      if (!a.fit) continue;
      const k = a.date.slice(0, 7);
      const z = months.get(k) ?? [0, 0, 0];
      a.fit.zones3.forEach((s, i) => (z[i] += s));
      months.set(k, z);
    }
    return [...months.entries()].sort().map(([k, z]) => ({ key: k, z, pi: polarizationIndex(z) }));
  });

  protected readonly zonesTotal = computed(() => {
    const z = [0, 0, 0];
    for (const m of this.zonesByMonth()) m.z.forEach((s, i) => (z[i] += s));
    const total = z.reduce((s, x) => s + x, 0) || 1;
    const pct = z.map((s) => (s / total) * 100);
    const pi = polarizationIndex(z);
    const model = pi !== null && pi > 2 ? 'polarisée' : pct[0] > pct[1] && pct[1] > pct[2] ? 'pyramidale' : pct[1] >= pct[0] ? 'au seuil' : 'mixte';
    return { pct, pi, model };
  });

  protected readonly zonesChart = computed<ChartConfiguration>(() => {
    const months = this.zonesByMonth();
    const names = ['Zone 1 · facile', 'Zone 2 · modérée', 'Zone 3 · intense'];
    const colors = [C.s1, C.amber, C.bad];
    return {
      type: 'bar',
      data: {
        labels: months.map((m) => monthFmt.format(new Date(Number(m.key.slice(0, 4)), Number(m.key.slice(5)) - 1, 1))),
        datasets: names.map((label, i) => ({
          label,
          data: months.map((m) => Math.round(m.z[i] / 60)),
          backgroundColor: colors[i],
          borderColor: C.surface,
          borderWidth: { top: 2 },
          borderSkipped: false,
          stack: 'z',
        })),
      },
      options: {
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: { display: true, text: 'minutes' } } },
        plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${c.parsed.y} min` } } },
      },
    };
  });

  protected readonly loadWeeks = computed(() => {
    const out = [];
    const ath = this.ath();
    for (let i = 7; i >= 0; i--) {
      const start = addDays(startOfWeek(this.today), -7 * i);
      const days = dailyLoads(this.acts(), start, addDays(start, 6), (a) => a.trainingLoad ?? null);
      const f = foster(days);
      const tr = dailyLoads(this.acts(), start, addDays(start, 6), (a) => trimp(a, ath)).reduce((s, x) => s + x, 0);
      out.push({ start, ...f, trimp: tr });
    }
    return out;
  });

  // Forme, fatigue & fraîcheur (modèle de Banister, ex-Forme › Performance & charge)
  protected readonly ranges = [
    { days: 91, label: '3 mois' },
    { days: 182, label: '6 mois' },
    { days: 365, label: '1 an' },
    { days: 0, label: 'Tout' },
  ];
  protected readonly range = signal(182);
  private readonly pmcAll = computed(() => pmc(this.acts(), this.today));
  private readonly pmcShown = computed(() => {
    const days = this.range();
    if (!days) return this.pmcAll();
    const from = addDays(this.today, -days);
    return this.pmcAll().filter((d) => d.date > from);
  });
  protected readonly pmcNow = computed(() => this.pmcAll().at(-1) ?? null);
  protected readonly freshness = computed(() => freshnessState(this.pmcNow()?.tsb ?? 0));

  protected readonly pmcChart = computed<ChartConfiguration>(() => {
    const days = this.pmcShown();
    const line = (label: string, key: 'ctl' | 'atl', color: string, width: number) => ({
      label,
      data: days.map((d) => Math.round(d[key] * 10) / 10),
      borderColor: color,
      backgroundColor: color,
      borderWidth: width,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.2,
    });
    return {
      type: 'line',
      data: {
        labels: days.map((d) => short.format(d.date)),
        datasets: [line('Forme (42 j)', 'ctl', C.s1, 3), line('Fatigue (7 j)', 'atl', C.s2, 1.5)],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } }, y: { beginAtZero: true } },
        plugins: {
          legend: { position: 'top', align: 'end' },
          tooltip: { callbacks: { footer: (i) => `Charge du jour : ${num(days[i[0].dataIndex].load)}` } },
        },
      },
    };
  });

  protected readonly tsbChart = computed<ChartConfiguration>(() => {
    const days = this.pmcShown();
    return {
      type: 'bar',
      data: {
        labels: days.map((d) => short.format(d.date)),
        datasets: [
          {
            label: 'Fraîcheur',
            data: days.map((d) => Math.round(d.tsb)),
            backgroundColor: days.map((d) => (d.tsb >= 0 ? C.s1 : C.bad)),
            barPercentage: 1,
            categoryPercentage: 1,
          },
        ],
      },
      options: {
        scales: { x: { display: false }, y: { title: { display: true, text: 'Fraîcheur' } } },
        plugins: { legend: { display: false } },
      },
    };
  });

  /** Dernier statut de charge Coros (ratio court / long terme) */
  protected readonly corosLoad = computed(() => {
    const last = this.store.data()?.load?.at(-1);
    if (!last) return null;
    const s = LOAD_STATUS[last.comment ?? ''] ?? { label: last.comment ?? '–', tone: 'neutral' as const };
    return { ...s, ratio: last.ratio };
  });

  /** Charge par semaine sur 26 semaines, avec la monotonie de Foster en option */
  protected readonly showMonotony = signal(false);
  private readonly loadWeeks26 = computed(() => {
    const weeks = weekly(this.acts(), this.today, 26);
    return weeks.map((w) => {
      const days = dailyLoads(this.acts(), w.start, addDays(w.start, 6), (a) => a.trainingLoad ?? null);
      return { ...w, monotony: foster(days).monotony };
    });
  });

  protected readonly weeklyLoad = computed<ChartConfiguration>(() => {
    const weeks = this.loadWeeks26();
    const mono = this.showMonotony();
    return {
      type: 'bar',
      data: {
        labels: weeks.map((w) => short.format(w.start)),
        datasets: [
          {
            label: 'Charge',
            data: weeks.map((w) => w.load),
            backgroundColor: C.s1,
            borderRadius: { topLeft: 4, topRight: 4 },
            borderSkipped: 'bottom',
            order: 2,
          },
          ...(mono
            ? [
                {
                  type: 'line' as const,
                  label: 'Monotonie',
                  data: weeks.map((w) => (w.count ? Math.round(w.monotony * 100) / 100 : null)),
                  borderColor: C.amber,
                  backgroundColor: C.amber,
                  borderWidth: 2,
                  pointRadius: 3,
                  tension: 0.25,
                  spanGaps: true,
                  yAxisID: 'y1',
                  order: 1,
                },
              ]
            : []),
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          y: { beginAtZero: true, title: { display: mono, text: 'charge' } },
          y1: { display: mono, position: 'right', beginAtZero: true, suggestedMax: 2.5, grid: { display: false }, title: { display: true, text: 'monotonie' } },
        },
        plugins: {
          legend: { display: mono, position: 'top', align: 'end' },
          tooltip: {
            callbacks: {
              title: (items) => `Semaine du ${items[0]?.label}`,
              label: (c) =>
                c.datasetIndex === 0
                  ? ` Charge ${num(c.parsed.y ?? 0)} · ${weeks[c.dataIndex].count} sortie${weeks[c.dataIndex].count > 1 ? 's' : ''}`
                  : ` Monotonie ${num(c.parsed.y ?? 0, 2)}`,
            },
          },
        },
      },
    };
  });

  protected readonly acwrChart = computed<ChartConfiguration>(() => {
    const from = addDays(this.today, -240);
    const daily = dailyLoads(this.acts(), from, this.today, (a) => a.trainingLoad ?? null);
    const ratio = acwr(daily).slice(-120);
    const dates = ratio.map((_, i) => addDays(this.today, i - ratio.length + 1));
    const labels = dates.map((d) => short.format(d));
    const band = (y: number) => ratio.map(() => y);
    // Ratio court / long terme de Coros (31 derniers jours) en repère
    const coros = new Map((this.store.data()?.load ?? []).map((d) => [d.date, d.ratio]));
    const corosSeries = dates.map((d) => coros.get(isoDay(d)) ?? null);
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Ratio aigu / chronique', data: ratio.map((r) => Math.round(r * 100) / 100), borderColor: C.s1, backgroundColor: C.s1, borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: 'Zone 0,8 – 1,3', data: band(1.3), borderColor: alpha(C.neutral, 0.5), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false },
          { label: '', data: band(0.8), borderColor: alpha(C.neutral, 0.5), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, fill: false },
          ...(corosSeries.some((x) => x !== null)
            ? [{ label: 'Ratio Coros', data: corosSeries, borderColor: C.accent, backgroundColor: C.accent, borderWidth: 2, borderDash: [2, 3], pointRadius: 0, tension: 0.3 }]
            : []),
        ],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } }, y: { suggestedMin: 0.4, suggestedMax: 1.8 } },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { filter: (l) => !!l.text } },
          tooltip: { filter: (i) => i.datasetIndex === 0 || i.datasetIndex === 3, callbacks: { label: (c) => ` ${c.dataset.label} : ${num(c.parsed.y ?? 0, 2)}` } },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Chaleur & types de séances
  // -------------------------------------------------------------------------

  protected readonly hottest = computed(() =>
    this.acts()
      .filter((a) => a.weather && a.kind !== 'indoor' && a.distanceKm >= 3)
      .sort((a, b) => b.weather!.temp - a.weather!.temp)
      .slice(0, 8)
      .map((a) => ({
        a,
        penalty: heatPenalty(a.weather!.temp, a.weather!.dew),
        rawPace: a.durationSec / a.distanceKm,
        adjusted: heatAdjustedPace(a),
      })),
  );

  protected readonly typesChart = computed<ChartConfiguration>(() => {
    const keys = Object.keys(SESSION_TYPES) as SessionType[];
    const months = new Map<string, Record<string, number>>();
    for (const a of this.acts()) {
      const m = a.date.slice(0, 7);
      const row = months.get(m) ?? {};
      const t = this.sci.types().get(a.id) ?? 'easy';
      row[t] = (row[t] ?? 0) + 1;
      months.set(m, row);
    }
    const sorted = [...months.entries()].sort().slice(-18);
    return {
      type: 'bar',
      data: {
        labels: sorted.map(([k]) => monthFmt.format(new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1))),
        datasets: keys.map((k) => ({
          label: SESSION_TYPES[k].label,
          data: sorted.map(([, row]) => row[k] ?? 0),
          backgroundColor: SESSION_TYPES[k].color,
          borderColor: C.surface,
          borderWidth: { top: 2 },
          borderSkipped: false,
          stack: 't',
        })),
      },
      options: {
        scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { precision: 0 }, title: { display: true, text: 'sorties' } } },
        plugins: { legend: { position: 'top', align: 'start' } },
      },
    };
  });

  protected readonly typeCounts = computed(() => {
    const counts = new Map<SessionType, number>();
    this.sci.types().forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
    return (Object.keys(SESSION_TYPES) as SessionType[]).map((k) => ({ key: k, ...SESSION_TYPES[k], count: counts.get(k) ?? 0 }));
  });

  // -------------------------------------------------------------------------
  // Allure, FC & cadence par mois (ex-Progression)
  // -------------------------------------------------------------------------

  private trendLine(labels: string[], data: number[], color: string, unit: (v: number) => string, reverse = false): ChartConfiguration {
    return {
      type: 'line',
      data: {
        labels,
        datasets: [{ label: '', data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, tension: 0.25 }],
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          // Allure : axe inversé, plus haut = plus rapide
          y: { reverse, ticks: { callback: (v) => unit(Number(v)) } },
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${unit(c.parsed.y ?? 0)}` } } },
      },
    };
  }

  protected readonly paceTrend = computed(() => {
    // Le trail et le tapis faussent l'allure : on ne garde que la route et la piste
    const flat = this.acts().filter((a) => a.kind === 'road' || a.kind === 'track');
    const m = monthly(flat, this.today, 24).filter((b) => b.count > 0);
    return this.trendLine(m.map((b) => monthFmt.format(b.start)), m.map((b) => Math.round(b.sec / b.km)), C.s1, (v) => `${pace(v)} /km`, true);
  });

  protected readonly hrTrend = computed(() => {
    const m = monthly(this.acts(), this.today, 24).filter((b) => b.count > 0 && b.hrSec > 0);
    return this.trendLine(m.map((b) => monthFmt.format(b.start)), m.map((b) => Math.round(b.hrSum / b.hrSec)), C.s2, (v) => `${num(v)} bpm`);
  });

  protected readonly cadenceTrend = computed(() => {
    const byMonth = new Map<string, { sum: number; sec: number }>();
    for (const a of this.acts()) {
      if (!a.cadence) continue;
      const k = a.date.slice(0, 7);
      const m = byMonth.get(k) ?? { sum: 0, sec: 0 };
      m.sum += a.cadence * a.durationSec;
      m.sec += a.durationSec;
      byMonth.set(k, m);
    }
    const keys = [...byMonth.keys()].sort().slice(-24);
    return this.trendLine(
      keys.map((k) => monthFmt.format(new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1))),
      keys.map((k) => Math.round(byMonth.get(k)!.sum / byMonth.get(k)!.sec)),
      C.s3,
      (v) => `${num(v)} ppm`,
    );
  });

  /** Séances selon le focus Coros (ex-Habitudes), à comparer à la classification automatique */
  protected readonly focusChart = computed<ChartConfiguration>(() => {
    const counts = new Map<string, number>();
    for (const a of this.acts()) if (a.focus) counts.set(a.focus, (counts.get(a.focus) ?? 0) + 1);
    const keys = Object.keys(FOCUS).filter((k) => counts.has(k));
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    return {
      type: 'bar',
      data: {
        labels: keys.map((k) => FOCUS[k]),
        datasets: [{ label: 'Sorties', data: keys.map((k) => counts.get(k)!), backgroundColor: C.s1, borderRadius: 4, barPercentage: 0.8 }],
      },
      options: {
        indexAxis: 'y',
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => ` ${c.parsed.x} sorties · ${num(((c.parsed.x ?? 0) / total) * 100)} %` } },
        },
      },
    };
  });

  // -------------------------------------------------------------------------
  // Résumés « En bref » de chaque sous-onglet, calculés sur les mêmes données que les graphiques
  // -------------------------------------------------------------------------

  protected readonly brief = computed<LabSummary | null>(() => {
    switch (this.view()) {
      case 'predictions': return this.sumPredictions();
      case 'matrice': return this.sumMatrix();
      case 'efficacite': return this.sumEfficiency();
      case 'durabilite': return this.sumDurability();
      case 'charge': return this.sumLoad();
      case 'seances': return this.sumTypes();
    }
  });

  /** Efficacité : forme FC/allure, puis l'effet de la chaleur */
  private readonly sumEfficiency = computed<LabSummary | null>(() => {
    const form = this.sumForm();
    const heat = this.sumHeat();
    if (!form) return heat;
    return { title: form.title, points: [...form.points, ...(heat ? [`${heat.title}.`, ...heat.points.slice(1, 2)] : [])] };
  });

  private readonly sumMatrix = computed<LabSummary | null>(() => {
    const scored = this.sci.matrix().branches.filter((b) => b.score !== null);
    if (!scored.length) return null;
    const sorted = [...scored].sort((a, b) => b.score! - a.score!);
    const names = (bs: typeof scored) => bs.map((b) => `${b.label} (${num(b.score!)})`).join(', ');
    const points = [`Au plus haut par rapport à ton historique : ${names(sorted.slice(0, 2))}.`];
    const low = sorted.filter((b) => b.score! < 50);
    if (low.length) points.push(`En dessous de ta moyenne : ${names(low)}.`);
    const moves = scored
      .filter((b) => b.scoreThen !== null && Math.abs(b.score! - b.scoreThen) >= 15)
      .map((b) => `${b.label} ${b.score! > b.scoreThen! ? '+' : '−'}${num(Math.abs(b.score! - b.scoreThen!))}`);
    if (moves.length) points.push(`Changements nets en six mois : ${moves.join(', ')}.`);
    const abs = scored.filter((b) => b.abs !== null);
    if (abs.length) {
      points.push(
        `Lecture absolue : ${abs.map((b) => `${b.label} ${num(b.abs!)} % du niveau mondial (${worldLevel(b.abs!)})`).join(', ')}.`,
      );
    }
    const partial = this.sci.matrix().branches.filter((b) => b.confidence !== 'solide').map((b) => b.label);
    if (partial.length) points.push(`Données incomplètes pour : ${partial.join(', ')}.`);
    return { title: `Point fort : ${sorted[0].label} · à travailler : ${sorted.at(-1)!.label}`, points };
  });

  private readonly sumPredictions = computed<LabSummary | null>(() => {
    const ref = this.best();
    if (!ref) return null;
    const rows = this.predictions();
    const models = (r: (typeof rows)[number]) =>
      [r.coros, r.vdot, r.riegelPerso ?? r.riegel, r.cs, r.vickers, r.tanda].filter((x): x is number => !!x);
    const semi = models(rows[2]), marathon = models(rows[3]);
    const points: string[] = [`Référence : ${ref.label} (${this.fmt(ref.date)}), VDOT ${num(ref.vdot, 1)}.`];
    if (semi.length > 1) {
      const spread = Math.max(...semi) / Math.min(...semi) - 1;
      points.push(
        `Sur semi, les modèles vont de ${clock(Math.min(...semi))} à ${clock(Math.max(...semi))} : ` +
          (spread < 0.04 ? 'ils convergent, la prédiction est solide.' : 'gros écart, la référence date ou il manque des efforts maximaux récents.'),
      );
    }
    const k = this.sci.exponent()?.k;
    if (k) {
      points.push(
        `Exposant de fatigue pondéré ${fixed(k, 2)} (amateur moyen ≈ 1,07) : ` +
          (k > 1.09 ? 'tu perds plus que la moyenne quand la distance s\'allonge, l\'endurance est ton principal levier.'
            : k < 1.05 ? 'excellente endurance relative, ta vitesse est le facteur limitant.' : 'endurance dans la moyenne.'),
      );
    }
    const cs = this.sci.criticalSpeed();
    if (cs) points.push(`Vitesse critique ${pace(1000 / cs.cs)} /km (D′ ${num(cs.dPrime)} m) d'après ${cs.points.length} meilleurs efforts des 16 dernières semaines.`);
    const sh = this.shape();
    if (sh) points.push(`Marathon shape ${num(sh.shape)} % : ${sh.shape >= 100 ? 'volume et sorties longues suffisants pour le marathon prédit.' : `il manque du volume (${num(sh.weekly)} km/sem pour ${num(sh.weeklyTarget)} visés) ou des sorties longues pour tenir le marathon prédit.`}`);
    return {
      title: `Niveau actuel : semi ≈ ${semi.length ? clock(median(semi)) : '–'}, marathon ≈ ${marathon.length ? clock(median(marathon)) : '–'}`,
      points,
    };
  });

  private readonly sumForm = computed<LabSummary | null>(() => {
    const trend = this.formTrend(), ef = this.efTrend(), now = this.formNow();
    if (now === null && ef === null) return null;
    const up = (ef ?? 0) > 0.5 || (trend ?? 0) > 0.2;
    const down = (ef ?? 0) < -0.5 || (trend ?? 0) < -0.2;
    const points: string[] = [];
    if (ef !== null) {
      points.push(`Efficacité en endurance ${ef >= 0 ? '+' : '−'}${num(Math.abs(ef), 1)} % par trimestre sur 12 mois : ${ef >= 0 ? 'tu cours plus vite à FC égale.' : 'à FC égale, tu cours moins vite qu\'avant.'}`);
    }
    if (now !== null) points.push(`Indice de forme FC/allure ${num(now, 1)}${trend !== null ? ` (${trend >= 0 ? '+' : '−'}${num(Math.abs(trend), 1)} par mois sur 6 mois)` : ''}.`);
    const recent = this.anomalies().filter((p) => (this.today.getTime() - parseDay(p.activity.date).getTime()) / 86_400_000 <= 30);
    points.push(
      recent.length
        ? `${recent.length} sortie${recent.length > 1 ? 's' : ''} à FC anormalement haute ce dernier mois (dernière : ${recent[0].activity.name}, ${this.fmt(recent[0].activity.date)}) : chaleur, fatigue ou capteur.`
        : 'Aucune sortie à FC anormale ce dernier mois.',
    );
    const vo2 = this.store.data()?.fitness?.vo2max;
    const ref = this.best();
    if (vo2 && ref) points.push(`VO2max Coros ${vo2} contre VDOT ${num(ref.vdot, 1)} en course : l'écart entre le moteur et la performance réelle est normal, il se réduit avec l'économie de course.`);
    return { title: up && !down ? 'Ta forme progresse' : down && !up ? 'Ta forme marque le pas' : 'Forme stable', points };
  });

  private readonly sumDurability = computed<LabSummary | null>(() => {
    const d = this.dur();
    if (!d.runs.length) return null;
    const points: string[] = [];
    const dec = this.decoupled().slice(-10).map((a) => a.fit!.decoupling!);
    if (dec.length >= 3) {
      const m = median(dec);
      points.push(`Découplage médian ${num(m, 1)} % sur tes ${dec.length} dernières sorties faciles : ${m < 5 ? 'bonne endurance aérobie.' : m < 10 ? 'à surveiller, ralentis un peu en endurance fondamentale.' : 'ces sorties dépassent ton seuil aérobie.'}`);
    }
    if (d.road) points.push(`Route : ${d.road.median > 0 ? '−' : '+'}${num(Math.abs(d.road.median), 1)} % d'efficacité en fin de sortie (${d.road.n} sorties).`);
    if (d.trail) points.push(`Trail : ${d.trail.median > 0 ? '−' : '+'}${num(Math.abs(d.trail.median), 1)} % (${d.trail.n} sorties), plus exigeant pour les jambes.`);
    const drop = (c: (number | null)[]) => c.findIndex((x) => x !== null && x < 0.95);
    const tr = drop(d.curve.trail), rd = drop(d.curve.road);
    if (tr >= 0 || rd >= 0) {
      const when = rd >= 0 && rd === tr
        ? `à la ${rd + 1}e heure, sur route comme en trail`
        : [rd >= 0 ? `à la ${rd + 1}e heure sur route` : '', tr >= 0 ? `à la ${tr + 1}e heure en trail` : ''].filter(Boolean).join(' et ');
      points.push(`L'efficacité passe sous 95 % ${when} : c'est là que se jouent les longues courses.`);
    }
    if (d.hrDrift !== null) points.push(`Ta FC dérive de ${d.hrDrift >= 0 ? '+' : '−'}${num(Math.abs(d.hrDrift), 1)} bpm par heure à allure égale.`);
    const roadOk = !d.road || d.road.median <= 5, trailOk = !d.trail || d.trail.median <= 5;
    return {
      title: roadOk && trailOk ? 'Tu tiens bien la distance' : roadOk ? 'Solide sur route, plus fragile en trail long' : trailOk ? 'Solide en trail, plus fragile sur route' : 'La durabilité est ton axe de progrès',
      points,
    };
  });

  private readonly sumLoad = computed<LabSummary | null>(() => {
    const z = this.zonesTotal();
    const daily = dailyLoads(this.acts(), addDays(this.today, -240), this.today, (a) => a.trainingLoad ?? null);
    const ratio = acwr(daily).at(-1) ?? 0;
    const weeks = this.loadWeeks();
    const last = weeks.at(-2);
    const before = weeks.slice(-6, -2);
    const mean = before.length ? before.reduce((s, w) => s + w.load, 0) / before.length : 0;
    const points: string[] = [];
    const now = this.pmcNow();
    if (now) points.push(`Fraîcheur ${now.tsb > 0 ? '+' : ''}${num(now.tsb)} (forme ${num(now.ctl)}, fatigue ${num(now.atl)}) : ${this.freshness().text.toLowerCase()}`);
    if (this.zonesByMonth().length) {
      points.push(`Répartition ${z.model} : ${num(z.pct[0])} % facile, ${num(z.pct[1])} % modéré, ${num(z.pct[2])} % intense ${z.pct[0] >= 75 ? '(proche du 80/20 recommandé).' : '(moins de 75 % en facile : le 80/20 laisserait plus de place à la récupération).'}`);
    }
    points.push(`Ratio charge aiguë / chronique ${num(ratio, 2)} : ${ratio > 1.5 ? 'hausse brutale, prudence.' : ratio > 1.3 ? 'charge en nette hausse.' : ratio < 0.8 ? 'charge en baisse (affûtage ou repos).' : 'progression maîtrisée.'}`);
    if (last && mean) points.push(`Semaine dernière : charge ${num(last.load)} (${last.load >= mean ? '+' : '−'}${num(Math.abs(last.load / mean - 1) * 100)} % par rapport aux 4 précédentes), monotonie ${num(last.monotony, 2)}${last.monotony > 1.5 ? ' : alterne davantage jours durs et faciles.' : '.'}`);
    return {
      title: ratio > 1.5 ? 'Charge en forte hausse' : ratio > 1.3 ? 'Charge en hausse' : ratio < 0.8 ? 'Charge en baisse' : 'Charge maîtrisée',
      points,
    };
  });

  private readonly sumHeat = computed<LabSummary | null>(() => {
    const year = this.acts().filter((a) => a.weather && a.kind !== 'indoor' && a.distanceKm >= 3 && (this.today.getTime() - parseDay(a.date).getTime()) / 86_400_000 <= 365);
    if (!year.length) return null;
    const pen = year.map((a) => ({ a, p: heatPenalty(a.weather!.temp, a.weather!.dew) }));
    const hit = pen.filter((x) => x.p >= 1);
    const summer = pen.filter((x) => ['06', '07', '08'].includes(x.a.date.slice(5, 7)));
    const avgSummer = summer.length ? summer.reduce((s, x) => s + x.p, 0) / summer.length : 0;
    const worst = pen.reduce((m, x) => (x.p > m.p ? x : m), pen[0]);
    const points = [
      `${hit.length} sortie${hit.length > 1 ? 's' : ''} sur ${year.length} en 12 mois ralentie${hit.length > 1 ? 's' : ''} d'au moins 1 % par la chaleur.`,
      `En été (juin à août), la chaleur t'a coûté en moyenne ${num(avgSummer, 1)} % d'allure, soit ≈ ${num((avgSummer / 100) * 330)} s/km à 5:30.`,
      `Pire sortie : ${worst.a.name} (${this.fmt(worst.a.date)}), ${num(worst.a.weather!.temp)} °C et rosée ${num(worst.a.weather!.dew)} °C → +${num(worst.p, 1)} %.`,
    ];
    const next = this.sci.upcomingGoals().find((e) => e.goal.forecast);
    if (next?.goal.forecast) {
      const f = next.goal.forecast;
      const p = heatPenalty(f.temp, f.dew);
      points.push(`${next.goal.name} : ${num(f.temp)} °C et rosée ${num(f.dew)} °C prévus, ${p > 0.2 ? `+${num(p, 1)} % attendus.` : 'aucun effet de la chaleur attendu.'}`);
    }
    return { title: avgSummer >= 2 ? `L'été te coûte ≈ ${num(avgSummer, 1)} % d'allure` : 'La chaleur pèse peu sur tes sorties', points };
  });

  private readonly sumTypes = computed<LabSummary | null>(() => {
    const recent = this.acts().filter((a) => (this.today.getTime() - parseDay(a.date).getTime()) / 86_400_000 < 56);
    if (!recent.length) return null;
    const counts = new Map<SessionType, number>();
    for (const a of recent) {
      const t = this.sci.types().get(a.id) ?? 'easy';
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const n = (t: SessionType) => counts.get(t) ?? 0;
    const hard = n('interval') + n('tempo') + n('race');
    const hardPct = (hard / recent.length) * 100;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      title: `${recent.length} sorties en 8 semaines, ${num(100 - hardPct)} % sans intensité`,
      points: [
        `Séance la plus fréquente : ${SESSION_TYPES[top[0]].label.toLowerCase()} (${top[1]}).`,
        `${hard} séance${hard > 1 ? 's' : ''} intense${hard > 1 ? 's' : ''} (fractionné, tempo, course), soit ${num(hardPct)} % : ${hardPct > 25 ? 'beaucoup, garde des jours vraiment faciles autour.' : hardPct < 8 ? 'très peu, une séance de qualité par semaine suffirait à progresser.' : 'dosage équilibré.'}`,
        `${n('long')} sortie${n('long') > 1 ? 's' : ''} longue${n('long') > 1 ? 's' : ''} et ${n('trail')} trail${n('trail') > 1 ? 's' : ''} sur la période.`,
      ],
    };
  });
}

interface LabSummary {
  title: string;
  points: string[];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
