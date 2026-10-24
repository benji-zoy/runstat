import { Component, computed, inject, input, signal } from '@angular/core';
import { DataService } from '../core/data.service';
import { BADGES, LEVELS, levelFor } from '../core/badges';
import { milestones } from '../core/insights';
import { day, km, num } from '../core/format';
import { parseDay } from '../core/stats';

@Component({
  selector: 'app-badges',
  template: `
    @switch (view()) {
      @case ('badges') {
    <section class="section">
      <div class="card level" [style.--lvl]="lvl().level.color">
        <div class="lvl-main">
          <span class="label">Ton niveau</span>
          <span class="display lvl-name">{{ lvl().level.name }}</span>
          <span class="muted">{{ km(totalKm()) }} parcourus depuis le début</span>
        </div>
        @if (lvl().next; as next) {
          <div class="lvl-next">
            <div class="lvl-bar"><span [style.width.%]="lvl().progress * 100"></span></div>
            <span>
              Plus que <b>{{ km(next.min - totalKm()) }}</b> pour le niveau
              <b [style.color]="next.color">{{ next.name }}</b>
            </span>
          </div>
        }
        <div class="ladder">
          @for (l of levels; track l.name) {
            <span class="step" [class.done]="totalKm() >= l.min" [style.--c]="l.color" [title]="l.name + ' · ' + num(l.min) + ' km'">
              <i></i>{{ l.name }}<small>{{ num(l.min) }} km</small>
            </span>
          }
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Badges <small>{{ earnedCount() }} / {{ badges().length }} obtenus</small></h2>
      <div class="chips">
        @for (f of families(); track f) {
          <button type="button" class="chip" [class.active]="family() === f" (click)="family.set(f)">{{ f }}</button>
        }
      </div>
      <div class="grid badge-grid">
        @for (b of shown(); track b.id) {
          <div class="card badge" [class.locked]="!b.result.earned">
            <span class="b-icon">{{ b.icon }}</span>
            <div class="b-body">
              <span class="b-name">
                {{ b.name }}
                @if (b.result.times && b.result.times > 1) {
                  <span class="times">×{{ b.result.times }}</span>
                }
              </span>
              <span class="muted b-desc">{{ b.description }}</span>
              @if (b.result.earned) {
                <span class="b-date">Obtenu le {{ fmt(b.result.earned) }}</span>
              } @else {
                <div class="b-prog"><span [style.width.%]="b.result.progress * 100"></span></div>
                <span class="muted b-hint">{{ b.result.hint }}</span>
              }
            </div>
          </div>
        }
      </div>
    </section>
      }
      @case ('jalons') {
    <section class="section">
      <h2>Jalons &amp; premières fois</h2>
      <div class="card">
        <ol class="timeline">
          @for (m of milestones(); track m.date + m.label) {
            <li>
              <span class="t-date muted">{{ fmt(m.date) }}</span>
              <span class="t-dot">{{ m.icon }}</span>
              <span class="t-label">{{ m.label }}</span>
            </li>
          }
        </ol>
      </div>
    </section>
      }
    }
  `,
  styles: `
    .level {
      display: grid; gap: 1.2rem; border-color: var(--lvl);
      background: radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--lvl) 18%, transparent), var(--surface-1) 60%);
    }
    .lvl-main { display: grid; gap: 0.2rem; }
    .lvl-name { font-size: 4rem; color: var(--lvl); text-transform: uppercase; }
    .lvl-next { display: grid; gap: 0.5rem; }
    .lvl-bar { height: 10px; border-radius: 5px; background: var(--surface-3); overflow: hidden; }
    .lvl-bar span { display: block; height: 100%; background: var(--lvl); border-radius: 5px; }
    .ladder { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .step {
      display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0.7rem; border-radius: 999px;
      background: var(--surface-2); font-size: 0.82rem; color: var(--text-muted);
    }
    .step i { width: 0.6rem; height: 0.6rem; border-radius: 50%; background: var(--surface-3); }
    .step.done { color: var(--text-primary); }
    .step.done i { background: var(--c); }
    .step small { color: var(--text-muted); }
    .badge-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
    .lvl-name { font-size: clamp(2.6rem, 10vw, 4rem); }
    @media (max-width: 600px) { .timeline li { grid-template-columns: 5.8rem 1.8rem 1fr; } }
    .badge { display: grid; grid-template-columns: 3.2rem 1fr; gap: 0.8rem; align-items: start; }
    .b-icon {
      width: 3.2rem; height: 3.2rem; border-radius: 50%; display: grid; place-items: center; font-size: 1.6rem;
      background: radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, var(--surface-2)), var(--surface-2)); border: 2px solid var(--accent);
    }
    .locked .b-icon { filter: grayscale(1); opacity: 0.45; border-color: var(--surface-3); background: var(--surface-2); }
    .b-body { display: grid; gap: 0.2rem; min-width: 0; }
    .b-name { font-weight: 700; }
    .times { margin-left: 0.3rem; font-size: 0.75rem; color: var(--accent); }
    .b-desc { font-size: 0.82rem; }
    .b-date { font-size: 0.8rem; color: var(--good-text); }
    .b-prog { height: 6px; border-radius: 3px; background: var(--surface-3); overflow: hidden; margin-top: 0.25rem; }
    .b-prog span { display: block; height: 100%; background: var(--text-muted); border-radius: 3px; }
    .b-hint { font-size: 0.78rem; }
    .timeline { list-style: none; margin: 0; padding: 0; display: grid; }
    .timeline li {
      display: grid; grid-template-columns: 7.5rem 2.2rem 1fr; align-items: center; gap: 0.5rem; padding: 0.45rem 0;
      border-bottom: 1px solid var(--border);
    }
    .t-date { font-size: 0.82rem; font-variant-numeric: tabular-nums; }
    .t-dot { font-size: 1.2rem; text-align: center; }
  `,
})
export class BadgesPage {
  readonly view = input<'badges' | 'jalons'>('badges');

  private readonly store = inject(DataService);
  protected readonly km = km;
  protected readonly num = num;
  protected readonly levels = LEVELS;
  protected fmt = (iso: string) => day(parseDay(iso));

  protected readonly totalKm = computed(() => this.store.activities().reduce((s, a) => s + a.distanceKm, 0));
  protected readonly lvl = computed(() => levelFor(this.totalKm()));

  protected readonly badges = computed(() => {
    const acts = this.store.activities();
    return BADGES.map((b) => ({ ...b, result: b.eval(acts) }));
  });
  protected readonly earnedCount = computed(() => this.badges().filter((b) => b.result.earned).length);

  protected readonly families = computed(() => ['Tous', ...new Set(BADGES.map((b) => b.family))]);
  protected readonly family = signal('Tous');

  /** Obtenus d'abord (du plus récent au plus ancien), puis les plus proches d'être obtenus */
  protected readonly shown = computed(() =>
    this.badges()
      .filter((b) => this.family() === 'Tous' || b.family === this.family())
      .sort((a, b) => {
        if (a.result.earned && b.result.earned) return b.result.earned.localeCompare(a.result.earned);
        if (a.result.earned) return -1;
        if (b.result.earned) return 1;
        return b.result.progress - a.result.progress;
      }),
  );

  protected readonly milestones = computed(() => milestones(this.store.activities()));
}
