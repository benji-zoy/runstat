import { Injectable, inject, signal } from '@angular/core';
import { DataService } from './data.service';
import { PeriodService } from './period.service';
import { ScienceService } from './science.service';
import { GoalEvaluation } from './goals';
import { ConfidencePoint, PredictionPoint, confidenceDates, confidencePoint, currentPoint, predictionPoint } from './history';
import { isoDay } from './stats';

/** Temps de calcul d'affilée avant de rendre la main au navigateur (ms) */
const SLICE_MS = 25;

/**
 * Historiques recalculés (core/history.ts) : chaque point coûte une évaluation complète, ils sont donc calculés par petits
 * morceaux sans figer l'écran, et gardés tant que les données ne changent pas (changer de période ou revenir sur une
 * course est immédiat). Les lectures renvoient `null` tant que le calcul est en cours.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly store = inject(DataService);
  private readonly sci = inject(ScienceService);
  private readonly today = inject(PeriodService).today;

  /** Incrémenté à la fin de chaque série de calculs : les lectures en dépendent */
  private readonly version = signal(0);
  private inputs: unknown[] = [];
  private readonly cache = new Map<string, unknown>();
  private readonly queued = new Set<string>();
  private queue: [string, () => unknown][] = [];

  /** Chrono estimé sur les distances de référence à chaque date */
  predictions(dates: Date[]): PredictionPoint[] | null {
    const [acts, types, athlete] = this.fresh();
    return this.read(dates.map((d) => [`p|${isoDay(d)}`, () => predictionPoint(acts, types, athlete, d)]));
  }

  /** Indice de confiance d'un objectif semaine après semaine, terminé par l'évaluation affichée */
  confidence(e: GoalEvaluation): ConfidencePoint[] | null {
    const [acts, types, athlete, health] = this.fresh();
    const g = e.goal;
    const key = `c|${JSON.stringify(g)}|`;
    const points = this.read<ConfidencePoint | null>(
      confidenceDates(g, this.today).map((d) => [key + isoDay(d), () => confidencePoint(g, d, acts, types, athlete, health)]),
    );
    return points && [...points.filter((p): p is ConfidencePoint => p !== null), currentPoint(e, this.today)];
  }

  /** Données du calcul ; le cache est vidé quand elles changent (synchro, saisie) */
  private fresh() {
    const now = [this.store.activities(), this.sci.types(), this.sci.athlete(), this.store.data()?.health ?? null] as const;
    if (now.some((x, i) => x !== this.inputs[i])) {
      this.inputs = [...now];
      this.cache.clear();
      this.queued.clear();
      this.queue = [];
    }
    return now;
  }

  private read<T>(jobs: [string, () => T][]): T[] | null {
    this.version();
    const missing = jobs.filter(([k]) => !this.cache.has(k));
    if (!missing.length) return jobs.map(([k]) => this.cache.get(k) as T);
    const start = !this.queue.length;
    for (const job of missing) {
      if (this.queued.has(job[0])) continue;
      this.queued.add(job[0]);
      this.queue.push(job);
    }
    if (start) setTimeout(() => this.run());
    return null;
  }

  private run(): void {
    const t = performance.now();
    while (this.queue.length && performance.now() - t < SLICE_MS) {
      const [k, fn] = this.queue.shift()!;
      this.cache.set(k, fn());
      this.queued.delete(k);
    }
    if (this.queue.length) setTimeout(() => this.run());
    else this.version.update((v) => v + 1);
  }
}
