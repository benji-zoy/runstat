import { Component, computed, inject, input, signal } from '@angular/core';
import { corosSessions } from '../../engine/plan/coros-plan';
import { EntriesService } from '../core/entries.service';
import { GoalEvaluation } from '../core/goals';
import { PLAN_KIND_LABELS, planOf, planWeeks } from '../core/plan';
import { PeriodService } from '../core/period.service';
import { ScienceService } from '../core/science.service';
import { SyncService } from '../core/sync.service';
import { isoDay, parseDay } from '../core/stats';
import { duration, num } from '../core/format';
import { IconComponent } from '../ui/icon';
import { PlanImportComponent } from '../ui/forms/plan-import';
import { PlanWizardComponent } from '../ui/forms/plan-wizard';
import { errorList } from '../ui/forms/form-dialog';

const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const day = (iso: string) => dayFmt.format(parseDay(iso));
const stamp = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Plan d'entraînement d'un objectif (partie Préparation de la fiche) : préparer le texte pour une IA (assistant), importer
 * sa réponse, l'envoyer dans COROS, le lire semaine par semaine.
 */
@Component({
  selector: 'app-training-plan',
  imports: [IconComponent, PlanImportComponent, PlanWizardComponent],
  template: `
    <app-plan-wizard #wizard />
    <app-plan-import #importer />
    @let e = ev();
    <div class="head">
      <h3>Mon plan d'entraînement</h3>
      <div class="actions">
        <button type="button" class="btn small" (click)="wizard.open(e)"><app-icon name="chat" />Préparer mon plan avec une IA</button>
        @if (entries.available()) {
          <button type="button" class="btn small" (click)="importer.open(e)"><app-icon name="list" />{{ own().length ? 'Mettre à jour le plan' : 'Importer le plan' }}</button>
        }
      </div>
    </div>

    @if (inherited()) {
      <p class="muted small">Course de préparation : elle suit le plan de {{ mainName() }}.</p>
    }

    @if (own().length) {
      <p class="muted small">
        {{ own().length }} séances, du {{ day(own()[0].date) }} au {{ day(own().at(-1)!.date) }} · importé le {{ stamp(e.goal.plan!.importedAt) }}.
        @if (corosShadowed()) {
          Les semaines qui ont des séances dans le calendrier COROS suivent COROS.
        }
      </p>

      @if (entries.available() && corosReady()) {
        <div class="coros">
          <button type="button" class="btn small" [disabled]="entries.saving()" (click)="toCoros()"><app-icon name="sync" />{{ coros()?.sentAt ? 'Renvoyer dans COROS' : 'Envoyer dans COROS' }}</button>
          @if (confirming()) {
            <div class="confirm" role="alertdialog" aria-label="Envoyer dans COROS">
              <p>{{ corosSummary() }}</p>
              <div class="actions">
                <button type="button" class="btn small" (click)="confirming.set(false)">Annuler</button>
                <button type="button" class="btn small primary" [disabled]="entries.saving()" (click)="send()">{{ entries.saving() ? 'Envoi…' : 'Envoyer' }}</button>
              </div>
            </div>
          }
          @if (coros(); as c) {
            @if (c.sentAt) {
              <p class="muted small">Dans COROS depuis le {{ stamp(c.sentAt) }} : {{ c.sessions }} séances sur {{ c.weeks }} semaines{{ c.until ? ' (jusqu’au ' + day(c.until) + ', le reste à un prochain envoi)' : '' }}.</p>
            }
            @if (c.errorAt && (!c.sentAt || c.errorAt > c.sentAt)) {
              <p class="warn small">Dernier envoi refusé ({{ stamp(c.errorAt) }}) : {{ c.error }}</p>
            }
          }
          @if (notice(); as n) {
            <p class="small" role="status">{{ n }}</p>
          }
        </div>
      }

      <div class="weeks">
        @for (w of weeks(); track w.start) {
          <details class="week" [open]="w.start === thisWeek()">
            <summary>
              <span class="w-title">Semaine du {{ day(w.start) }}{{ w.phase ? ' · ' + w.phase : '' }}</span>
              <span class="w-meta muted">{{ runs(w.sessions) }} séance{{ runs(w.sessions) > 1 ? 's' : '' }} · ≈ {{ num(w.km) }} km</span>
            </summary>
            <ul>
              @for (s of w.sessions; track $index) {
                <li [class.done]="s.date < today">
                  <span class="d">{{ day(s.date) }}</span>
                  <span class="k" [attr.data-kind]="s.kind">{{ kinds[s.kind] }}</span>
                  <span class="n"><b>{{ s.name }}</b>
                    @if (s.durationMin || s.distanceKm) {
                      <small class="muted">{{ s.durationMin ? duration(s.durationMin * 60) : '' }}{{ s.durationMin && s.distanceKm ? ' · ' : '' }}{{ s.distanceKm ? num(s.distanceKm, 1) + ' km' : '' }}</small>
                    }
                    @if (s.steps) {
                      <small class="steps">{{ s.steps }}</small>
                    }
                  </span>
                </li>
              }
            </ul>
          </details>
        }
      </div>
      @if (entries.available()) {
        <button type="button" class="btn small danger del" (click)="remove()"><app-icon name="close" />Supprimer le plan</button>
      }
    } @else if (!inherited()) {
      <p class="muted small">Pas encore de plan : « Préparer mon plan avec une IA » prépare le texte à lui donner (volume, séances, intensité, renfo, courses de préparation), puis importe sa réponse ici. L'indice de confiance en tiendra compte.</p>
    }
  `,
  styles: `
    :host { display: grid; gap: 0.7rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
    .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 0.5rem; }
    h3 { margin: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .small { margin: 0; font-size: 0.85rem; }
    .warn { color: var(--warning); }
    .coros { display: grid; gap: 0.4rem; justify-items: start; }
    .confirm { display: grid; gap: 0.5rem; padding: 0.7rem 0.85rem; border-radius: var(--radius); background: var(--surface-2); border: 1px solid var(--border); font-size: 0.88rem; }
    .confirm p { margin: 0; }
    .weeks { display: grid; gap: 0.35rem; }
    .week { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-1); }
    .week summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.3rem 0.8rem; padding: 0.6rem 0.8rem; cursor: pointer; font-size: 0.9rem; }
    .w-title { font-weight: 700; }
    .w-meta { font-size: 0.82rem; }
    .week ul { list-style: none; margin: 0; padding: 0 0.8rem 0.7rem; display: grid; gap: 0.45rem; }
    .week li { display: grid; grid-template-columns: 6.5rem 5.5rem 1fr; gap: 0.5rem; align-items: baseline; font-size: 0.86rem; }
    .week li.done { opacity: 0.6; }
    .d { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .k { font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); }
    .k[data-kind='quality'], .k[data-kind='race'] { color: var(--accent-text); }
    .n { display: grid; gap: 0.1rem; }
    .n small { font-size: 0.78rem; }
    .steps { font-family: var(--font-mono); font-size: 0.72rem !important; color: var(--text-secondary); overflow-wrap: anywhere; }
    .del { justify-self: start; }
    @media (max-width: 600px) {
      .week li { grid-template-columns: 1fr; gap: 0.1rem; }
    }
  `,
})
export class TrainingPlanComponent {
  readonly ev = input.required<GoalEvaluation>();
  protected readonly entries = inject(EntriesService);
  private readonly sci = inject(ScienceService);
  private readonly sync = inject(SyncService);
  private readonly ref = inject(PeriodService).today;
  protected readonly today = isoDay(this.ref);
  protected readonly kinds = PLAN_KIND_LABELS;
  protected readonly num = num;
  protected readonly duration = duration;
  protected readonly day = day;
  protected readonly stamp = stamp;
  protected readonly confirming = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly own = computed(() => this.ev().goal.plan?.sessions ?? []);
  private readonly goals = computed(() => this.sci.goals().map((x) => x.goal));
  protected readonly inherited = computed(() => !this.own().length && planOf(this.ev().goal, this.goals()).length > 0);
  protected readonly mainName = computed(() => this.goals().find((g) => g.id === this.ev().goal.parent)?.name ?? '');
  protected readonly weeks = computed(() => planWeeks(this.own(), this.sci.loadRates()));
  protected readonly thisWeek = computed(() => this.weeks().filter((w) => w.start <= this.today).at(-1)?.start ?? this.weeks()[0]?.start ?? '');
  protected readonly coros = computed(() => this.ev().goal.plan?.coros ?? null);
  protected readonly corosReady = computed(() => !!this.sync.status()?.corosConnected);
  protected readonly corosShadowed = computed(() => this.sci.upcomingPlanned().some((s) => !s.imported) && this.own().some((s) => s.date >= this.today));
  protected readonly corosSummary = computed(() => {
    const plan = this.ev().goal.plan;
    if (!plan) return '';
    const running = corosSessions(plan).filter((s) => s.date >= this.today);
    const strength = plan.sessions.filter((s) => s.kind === 'strength' && s.date >= this.today).length;
    return `${running.length} séances de course à partir d'aujourd'hui (16 semaines au plus), dans un plan COROS « RunStat · ${this.ev().goal.name} »${this.coros()?.sentAt ? ' réécrit d’un bloc à partir d’aujourd’hui' : ''}. ${strength ? `Le renfo (${strength} séances) reste dans RunStat. ` : ''}Il apparaîtra dans le calendrier de la montre.`;
  });

  protected runs = (s: { kind: string }[]) => s.filter((x) => x.kind !== 'strength').length;

  protected toCoros(): void {
    this.notice.set(null);
    this.confirming.set(true);
  }

  protected async send(): Promise<void> {
    try {
      this.notice.set(await this.entries.sendPlanToCoros(this.ev().goal.id));
      this.confirming.set(false);
    } catch (e) {
      this.notice.set(errorList(e).join(' ; '));
      this.confirming.set(false);
    }
  }

  protected async remove(): Promise<void> {
    if (!confirm(`Supprimer le plan de ${this.ev().goal.name} ? Il reste dans COROS s'il y a été envoyé.`)) return;
    try {
      await this.entries.deletePlan(this.ev().goal.id);
    } catch (e) {
      this.notice.set(errorList(e).join(' ; '));
    }
  }
}
