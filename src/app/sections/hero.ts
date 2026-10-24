import { Component, computed, input } from '@angular/core';
import { Period, Summary } from '../core/models';
import { duration, num, pace } from '../core/format';

interface Kpi {
  label: string;
  value: string;
  unit: string;
  delta: number | null;
  /** true si une baisse est une bonne nouvelle (allure) */
  lowerIsBetter?: boolean;
  note?: string;
}

function delta(cur: number | null, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

@Component({
  selector: 'app-hero',
  template: `
    <section class="hero">
      <p class="lead">Tu as parcouru</p>
      <p class="big display">
        {{ distance() }}<span class="unit">km</span>
      </p>
      <p class="lead">
        {{ period().phrase }}
        @if (comparison(); as c) {
          <span class="cmp" [class.up]="c.up" [class.down]="!c.up">{{ c.text }}</span>
        }
      </p>
    </section>

    <div class="kpis">
      @for (k of kpis(); track k.label) {
        <div class="kpi">
          <span class="label">{{ k.label }}</span>
          <span class="value display">{{ k.value }}<small>{{ k.unit }}</small></span>
          @if (k.delta !== null) {
            <span class="delta" [class.good]="k.lowerIsBetter ? k.delta < 0 : k.delta > 0"
              [class.bad]="k.lowerIsBetter ? k.delta > 0 : k.delta < 0">
              {{ k.delta > 0 ? '▲' : k.delta < 0 ? '▼' : '=' }} {{ pct(k.delta) }}
            </span>
          } @else if (k.note) {
            <span class="delta muted">{{ k.note }}</span>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './hero.scss',
})
export class HeroComponent {
  readonly period = input.required<Period>();
  readonly summary = input.required<Summary>();
  readonly prev = input<Summary | null>(null);

  protected readonly distance = computed(() => num(this.summary().km, this.summary().km < 100 ? 1 : 0));

  protected readonly comparison = computed(() => {
    const p = this.prev();
    const prev = this.period().prev;
    if (!p || !prev) return null;
    const diff = this.summary().km - p.km;
    const sign = diff >= 0 ? '+' : '−';
    return { up: diff >= 0, text: `${sign}${num(Math.abs(diff), 1)} km par rapport à ${prev.label}` };
  });

  protected readonly kpis = computed<Kpi[]>(() => {
    const s = this.summary();
    const p = this.prev();
    const days = Math.max(1, Math.round((this.period().end.getTime() - this.period().start.getTime()) / 86_400_000));
    return [
      { label: 'Sorties', value: num(s.count), unit: '', delta: delta(s.count, p?.count) },
      { label: 'Temps', value: duration(s.sec), unit: '', delta: delta(s.sec, p?.sec) },
      { label: 'Dénivelé +', value: num(s.elev), unit: ' m', delta: delta(s.elev, p?.elev) },
      {
        label: 'Allure moyenne',
        value: pace(s.avgPaceSec),
        unit: ' /km',
        delta: delta(s.avgPaceSec, p?.avgPaceSec),
        lowerIsBetter: true,
      },
      { label: 'FC moyenne', value: s.avgHr ? num(s.avgHr) : '–', unit: ' bpm', delta: null, note: 'pondérée par la durée' },
      { label: 'Calories', value: num(s.calories), unit: ' kcal', delta: delta(s.calories, p?.calories) },
      days >= 14
        ? { label: 'Km par semaine', value: num((s.km / days) * 7, 1), unit: ' km', delta: null, note: `en moyenne sur ${num(days)} j` }
        : {
            label: 'Distance / sortie',
            value: s.count ? num(s.km / s.count, 1) : '–',
            unit: ' km',
            delta: delta(s.count ? s.km / s.count : null, p?.count ? p.km / p.count : null),
          },
      { label: 'Pas', value: num(s.steps), unit: '', delta: delta(s.steps, p?.steps), note: 'cadence × durée' },
    ];
  });

  protected pct(d: number): string {
    return `${num(Math.abs(d) * 100)} %`;
  }
}
