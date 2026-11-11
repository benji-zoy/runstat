import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { usePageTitle } from '../core/page-title';
import { ScienceService } from '../core/science.service';
import { DataService } from '../core/data.service';
import { PeriodService } from '../core/period.service';
import { EntriesService } from '../core/entries.service';
import { FOCUS, cycleTest } from '../core/cycle';
import { cycleTarget } from '../core/plan';
import { clock, fixed, num } from '../core/format';
import { parseDay } from '../core/stats';
import { IconComponent } from '../ui/icon';
import { TrainingPlanComponent } from '../sections/training-plan';
import { PlanWizardComponent } from '../ui/forms/plan-wizard';
import { errorList } from '../ui/forms/form-dialog';

const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Fiche d'un cycle d'entraînement sans course (`/cycles/:id`) : but et dates, suivi (séances faites, volume semaine par
 * semaine, charge, efficacité, VDOT), test de fin, plan (préparer, importer, envoyer dans COROS), bilan et cycle suivant.
 */
@Component({
  selector: 'app-cycle',
  imports: [RouterLink, IconComponent, TrainingPlanComponent, PlanWizardComponent],
  template: `
    <a class="back" routerLink="/courses"><app-icon name="back" />Courses</a>
    <app-plan-wizard #wizard />

    @if (cycle(); as c) {
      @let st = state()!;
      @let t = tracking()!;
      <header class="page-head">
        <div>
          <p class="kicker">Cycle sans course · {{ focus().label }}</p>
          <h1>{{ c.name }}</h1>
          <p class="lede">{{ focus().hint }} · du {{ day(c.start) }} au {{ day(st.end) }} ({{ c.weeks }} semaines)</p>
        </div>
        <span class="countdown display">{{ st.status === 'active' ? 'S' + st.week + '/' + c.weeks : st.status === 'upcoming' ? 'J-' + daysTo(c.start) : 'Terminé' }}</span>
      </header>

      @if (st.relay) {
        <p class="note">{{ st.relay.goal.name }} prend le relais à partir du {{ day(st.relay.date) }} : le cycle s'arrête la veille.</p>
      }

      <div class="row-actions">
        @if (entries.available()) {
          <button type="button" class="btn small" (click)="wizard.openCycle(c)"><app-icon name="edit" />Modifier le cycle</button>
          @if (st.status === 'done') {
            <button type="button" class="btn small primary" (click)="wizard.openCycle(null, { previous: c.id })"><app-icon name="plus" />Préparer le cycle suivant</button>
          }
          <button type="button" class="btn small danger" (click)="remove()"><app-icon name="close" />Supprimer</button>
        }
      </div>

      <section class="card panel">
        <h2>{{ st.status === 'done' ? 'Bilan' : 'Suivi' }}</h2>
        @if (st.status === 'upcoming') {
          <p class="muted small">Le cycle commence le {{ day(c.start) }} : le suivi (séances faites, charge, efficacité, VDOT) se remplira au fil des semaines.</p>
        }
        <div class="figures">
          <div><span class="label">Séances faites</span><span class="v">{{ t.doneToDate }}<small> / {{ t.plannedToDate }}</small></span>
            <span class="muted small">{{ t.plannedToDate ? num((t.doneToDate / t.plannedToDate) * 100) + ' % des séances prévues jusqu’ici' : 'aucune séance prévue encore passée' }}</span></div>
          <div><span class="label">Volume</span><span class="v">{{ num(t.doneKmToDate) }}<small> / {{ num(t.plannedKmToDate) }} km</small></span>
            <span class="muted small">fait / prévu jusqu'ici</span></div>
          @if (st.status !== 'upcoming' && t.acwr !== null) {
            <div><span class="label">Charge</span><span class="v" [class.warn]="t.acwr > 1.5">{{ fixed(t.acwr, 2) }}</span>
              <span class="muted small">{{ acwrLabel(t.acwr) }}</span></div>
          }
          @if (st.status !== 'upcoming' && t.ef.before && t.ef.now) {
            <div><span class="label">Efficacité (EF)</span><span class="v">{{ fixed(t.ef.now, 2) }}</span>
              <span class="muted small">{{ signed(((t.ef.now / t.ef.before) - 1) * 100) }} depuis le début</span></div>
          }
          @if (st.status !== 'upcoming' && t.vdot.now) {
            <div><span class="label">VDOT</span><span class="v">{{ fixed(t.vdot.now, 1) }}</span>
              <span class="muted small">{{ t.vdot.before ? (t.vdot.now - t.vdot.before >= 0 ? '+' : '−') + fixed(Math.abs(t.vdot.now - t.vdot.before), 1) + ' depuis le début' : 'meilleure référence' }}</span></div>
          }
        </div>

        @if (t.weeks.length) {
          <div class="weeks" role="list" aria-label="Volume semaine par semaine">
            @for (w of t.weeks; track w.start) {
              <div class="week" role="listitem" [class.future]="w.future">
                <span class="w-label">{{ short(w.start) }}</span>
                <div class="bars">
                  <span class="bar planned" [style.width.%]="pct(w.plannedKm)"></span>
                  <span class="bar done" [style.width.%]="pct(w.doneKm)"></span>
                </div>
                <span class="w-meta muted">{{ num(w.doneKm) }} / {{ num(w.plannedKm) }} km · {{ w.future ? w.plannedCount + ' prévues' : w.matched + '/' + w.plannedCount }}</span>
              </div>
            }
          </div>
          <p class="legend muted"><span class="dot planned"></span> prévu <span class="dot done"></span> fait · une séance compte comme faite s'il y a une sortie le même jour</p>
        }
      </section>

      @if (test(); as g) {
        <a class="card test" [routerLink]="['/courses', g.id]">
          <span class="label">Test de fin de cycle</span>
          <b>{{ g.name }}</b>
          <span class="muted small">{{ day(g.date) }}
            @if (testEval(); as e) {
              · {{ testDone() ? 'fait en ' + clock(testDone()!) : 'chrono probable ' + clock(e.predicted) }}
            }
          </span>
          <span class="go">Voir la fiche <app-icon name="arrow" /></span>
        </a>
      }

      <section class="card panel">
        <app-training-plan [target]="target()!" />
      </section>
    } @else {
      <div class="card missing">
        <p>Ce cycle n'existe pas (ou plus).</p>
        <a class="btn" routerLink="/courses">Voir les courses et les cycles</a>
      </div>
    }
  `,
  styles: `
    :host { display: grid; gap: 1.1rem; }
    .back { justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; min-height: 44px; margin: 1rem 0 -1rem; color: var(--accent-text); font-weight: 600; text-decoration: none; }
    .page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .kicker { margin: 0 0 0.2rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); }
    .countdown { font-size: 2.2rem; color: var(--accent); white-space: nowrap; }
    .note { margin: 0; padding: 0.6rem 0.8rem; border-radius: var(--radius); background: var(--surface-2); border-left: 3px solid var(--accent); font-size: 0.88rem; }
    .row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin: -0.4rem 0 -0.3rem; }
    .panel { display: grid; gap: 1rem; }
    .panel h2 { margin: 0; }
    .figures { display: grid; gap: 1rem 1.5rem; grid-template-columns: repeat(auto-fill, minmax(min(46%, 150px), 1fr)); }
    .figures > div { display: grid; gap: 0.2rem; align-content: start; }
    .label { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
    .v { font-family: var(--font-display); font-stretch: var(--display-stretch); font-weight: 800; font-size: 1.8rem; line-height: 1; font-variant-numeric: tabular-nums; }
    .v small { font-family: var(--font-body); font-size: 0.42em; font-weight: 600; color: var(--text-secondary); }
    .v.warn { color: var(--warning); }
    .small { font-size: 0.8rem; }
    .weeks { display: grid; gap: 0.35rem; }
    .week { display: grid; grid-template-columns: 4rem minmax(0, 1fr) auto; align-items: center; gap: 0.6rem; font-size: 0.82rem; }
    .week.future { opacity: 0.55; }
    .w-label { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .bars { position: relative; height: 12px; border-radius: 6px; background: var(--surface-3); overflow: hidden; }
    .bar { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px; }
    .bar.planned { background: color-mix(in srgb, var(--accent) 30%, transparent); }
    .bar.done { top: 3px; bottom: 3px; background: var(--accent-fill); }
    .w-meta { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .legend { margin: 0; font-size: 0.78rem; display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; }
    .dot.planned { background: color-mix(in srgb, var(--accent) 30%, transparent); }
    .dot.done { background: var(--accent-fill); }
    .test { display: grid; gap: 0.3rem; color: inherit; text-decoration: none; }
    .go { display: inline-flex; align-items: center; gap: 0.25rem; color: var(--accent-text); font-size: 0.85rem; font-weight: 600; }
    .missing { display: grid; gap: 0.75rem; justify-items: start; }
    @media (max-width: 600px) {
      .countdown { font-size: 1.6rem; }
      .week { grid-template-columns: 3.4rem minmax(0, 1fr); }
      .w-meta { grid-column: 2; }
    }
  `,
})
export class CyclePage {
  protected readonly sci = inject(ScienceService);
  protected readonly entries = inject(EntriesService);
  private readonly router = inject(Router);
  private readonly data = inject(DataService);
  private readonly params = toSignal(inject(ActivatedRoute).paramMap);

  protected readonly num = num;
  protected readonly fixed = fixed;
  protected readonly clock = clock;
  protected readonly Math = Math;

  private readonly pageTitle = usePageTitle(() => this.cycle()?.name);
  protected readonly cycle = computed(() => this.sci.cycles().find((c) => c.id === this.params()?.get('id')) ?? null);
  protected readonly focus = computed(() => FOCUS[this.cycle()?.focus ?? 'endurance']);
  protected readonly state = computed(() => (this.cycle() ? this.sci.cycleState(this.cycle()!) : null));
  protected readonly tracking = computed(() => (this.cycle() ? this.sci.cycleTracking(this.cycle()!) : null));
  protected readonly target = computed(() => (this.cycle() ? cycleTarget(this.cycle()!) : null));
  protected readonly test = computed(() => (this.cycle() ? cycleTest(this.cycle()!, this.data.data()?.goals ?? []) : null));
  protected readonly testEval = computed(() => this.sci.goals().find((e) => e.goal.id === this.test()?.id) ?? null);
  protected readonly testDone = computed(() => this.sci.debriefs().get(this.test()?.id ?? '')?.official ?? null);
  private readonly maxKm = computed(() => Math.max(1, ...(this.tracking()?.weeks ?? []).flatMap((w) => [w.plannedKm, w.doneKm])));

  protected pct = (km: number) => Math.min(100, (km / this.maxKm()) * 100);
  protected day = (iso: string) => dayFmt.format(parseDay(iso));
  protected short = (iso: string) => shortFmt.format(parseDay(iso));
  private readonly today = inject(PeriodService).today;
  protected daysTo = (iso: string) => Math.max(0, Math.round((parseDay(iso).getTime() - this.today.getTime()) / 86_400_000));
  protected signed = (x: number) => `${x >= 0 ? '+' : '−'}${fixed(Math.abs(x), 1)} %`;
  protected acwrLabel = (r: number) =>
    r > 1.5 ? 'charge qui monte trop vite : allège' : r < 0.8 ? 'charge en baisse (récupération ou reprise)' : 'charge maîtrisée (0,8 à 1,5)';

  protected async remove(): Promise<void> {
    const c = this.cycle();
    if (!c || !confirm(`Supprimer « ${c.name} », son plan et son test ? Un plan déjà envoyé reste dans COROS.`)) return;
    try {
      const d = this.data.data()?.goals ?? [];
      const test = cycleTest(c, d);
      if (c.plan) await this.entries.deletePlan(c.id);
      await this.entries.saveCycles(this.sci.cycles().filter((x) => x.id !== c.id));
      if (test) await this.entries.saveGoals(d.filter((g) => g.id !== test.id));
      void this.router.navigate(['/courses'], { replaceUrl: true });
    } catch (e) {
      alert(errorList(e).join(' ; '));
    }
  }
}
