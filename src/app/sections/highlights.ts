import { Component, computed, input } from '@angular/core';
import { Activity, Period } from '../core/models';
import { fastestOver, maxBy, monthly, parseDay, streaks, weekly } from '../core/stats';
import { clock, day, duration, km, month, num, pace } from '../core/format';

interface Rec {
  icon: string;
  label: string;
  value: string;
  detail: string;
}

@Component({
  selector: 'app-highlights',
  template: `
    <section class="section">
      <h2>Moments forts <small>{{ period().phrase }}</small></h2>
      @if (records().length) {
        <div class="grid recs">
          @for (r of records(); track r.label) {
            <div class="card rec">
              <span class="label">{{ r.icon }} {{ r.label }}</span>
              <span class="display value">{{ r.value }}</span>
              <span class="muted detail">{{ r.detail }}</span>
            </div>
          }
        </div>

      } @else {
        <p class="muted">Aucune sortie sur cette période.</p>
      }
    </section>
  `,
  styles: `
    .recs { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
    .rec { display: grid; gap: 0.35rem; }
    .label { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .value { font-size: 2.3rem; }
    .detail { font-size: 0.85rem; }
    .note { font-size: 0.8rem; margin: 0; }
  `,
})
export class HighlightsComponent {
  readonly period = input.required<Period>();
  readonly activities = input.required<Activity[]>();
  readonly today = input.required<Date>();

  protected readonly records = computed<Rec[]>(() => {
    const acts = this.activities();
    if (!acts.length) return [];
    const out: Rec[] = [];
    const describe = (a: Activity) => `${a.name || 'Sortie'} · ${day(parseDay(a.date))}`;

    const longest = maxBy(acts, (a) => a.distanceKm)!;
    out.push({ icon: '📏', label: 'Plus longue sortie', value: km(longest.distanceKm), detail: describe(longest) });

    const longestTime = maxBy(acts, (a) => a.durationSec)!;
    out.push({ icon: '⏱️', label: 'Plus long effort', value: clock(longestTime.durationSec), detail: describe(longestTime) });

    const heaviest = maxBy(acts, (a) => a.trainingLoad);
    if (heaviest?.trainingLoad) out.push({ icon: '🏋️', label: 'Plus grosse charge', value: String(heaviest.trainingLoad), detail: describe(heaviest) });

    const climb = maxBy(acts, (a) => a.elevGain);
    if (climb?.elevGain) out.push({ icon: '⛰️', label: 'Plus gros D+', value: `${num(climb.elevGain)} m`, detail: describe(climb) });

    for (const [label, min] of [
      ['5 km', 5],
      ['10 km', 10],
      ['semi', 21.0975],
    ] as const) {
      const a = fastestOver(acts, min);
      if (a) {
        out.push({
          icon: '⚡',
          label: `Meilleure allure ≥ ${label}`,
          value: `${pace(a.durationSec / a.distanceKm)} /km`,
          detail: `${km(a.distanceKm)} en ${clock(a.durationSec)} · ${day(parseDay(a.date))}`,
        });
      }
    }

    const bestKm = acts.reduce<Activity | null>(
      (best, a) => (a.bestKmSec && (!best || a.bestKmSec < best.bestKmSec!) ? a : best),
      null,
    );
    if (bestKm) out.push({ icon: '🚀', label: 'Kilomètre le plus rapide', value: `${pace(bestKm.bestKmSec)} /km`, detail: describe(bestKm) });

    const p = this.period();
    const weeks = Math.ceil((p.end.getTime() - p.start.getTime()) / (7 * 86_400_000)) + 1;
    const activeWeeks = weekly(acts, addDaysBefore(p.end), weeks).filter((w) => w.count > 0);
    const bestWeek = activeWeeks.length > 1 ? maxBy(activeWeeks, (w) => w.km) : null;
    if (bestWeek) out.push({ icon: '📅', label: 'Plus grosse semaine', value: km(bestWeek.km), detail: `Semaine du ${day(bestWeek.start)} · ${bestWeek.count} sortie${bestWeek.count > 1 ? 's' : ''}` });

    const months = (p.end.getFullYear() - p.start.getFullYear()) * 12 + p.end.getMonth() - p.start.getMonth() + 1;
    const activeMonths = monthly(acts, addDaysBefore(p.end), months).filter((m) => m.count > 0);
    const bestMonth = activeMonths.length > 1 ? maxBy(activeMonths, (m) => m.km) : null;
    if (bestMonth) out.push({ icon: '🗓️', label: 'Plus gros mois', value: km(bestMonth.km), detail: `${month(bestMonth.start)} · ${duration(bestMonth.sec)}` });

    const s = streaks(acts, this.today());
    if (s.longest > 1 && s.longestEnd) {
      out.push({ icon: '🔥', label: 'Plus longue série', value: `${s.longest} jours`, detail: `d'affilée, jusqu'au ${day(s.longestEnd)}` });
    }
    return out;
  });
}

/** La fin de période est exclusive : on prend la veille comme « aujourd'hui ». */
function addDaysBefore(end: Date): Date {
  return new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
}
