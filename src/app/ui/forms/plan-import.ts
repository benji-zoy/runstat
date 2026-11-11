import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { mergePlan, parsePlanMarkdown } from '../../../engine/plan/plan';
import { EntriesService } from '../../core/entries.service';
import { GoalEvaluation } from '../../core/goals';
import { PeriodService } from '../../core/period.service';
import { PlanTarget } from '../../core/plan';
import { ScienceService } from '../../core/science.service';
import { isoDay, parseDay } from '../../core/stats';
import { IconComponent } from '../icon';
import { errorList } from './form-dialog';

const short = (iso: string) => parseDay(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

/**
 * Import du plan rendu par l'IA (fichier .md / .txt ou texte collé) : lu sur l'appareil (src/engine/plan/plan.ts), aperçu
 * (séances lues, lignes ignorées, effet sur l'indice), puis enregistré. Les jours couverts par le nouveau plan remplacent
 * ceux de l'ancien, les autres sont gardés.
 */
@Component({
  selector: 'app-plan-import',
  imports: [IconComponent],
  template: `
    <dialog #dlg class="sheet" aria-label="Importer le plan" (close)="target.set(null)">
      @if (target(); as t) {
        <form novalidate (submit)="$event.preventDefault(); save()">
          <header>
            <h2>Importer le plan</h2>
            <button type="button" class="icon-btn" (click)="close()" aria-label="Fermer"><app-icon name="close" /></button>
          </header>
          <div class="body">
            <p class="muted small">Le fichier ou la réponse de l'IA, avec le bloc <code>runstat-plan</code> demandé à la fin de l'export.</p>
            <label class="btn file">Choisir un fichier .md ou .txt
              <input type="file" accept=".md,.txt,text/markdown,text/plain" (change)="pick($event)" hidden />
            </label>
            <label class="field">ou colle le texte
              <textarea rows="6" [value]="text()" (input)="text.set($any($event.target).value)" placeholder="\`\`\`runstat-plan&#10;2026-11-17 | facile | Footing | 45 min | 8 km | 45' Z2 | Foncier&#10;…"></textarea>
            </label>

            @if (text().trim()) {
              @let p = parsed();
              @if (p.sessions.length) {
                <ul class="facts">
                  <li><app-icon name="check" /> {{ p.sessions.length }} séance{{ p.sessions.length > 1 ? 's' : '' }} lue{{ p.sessions.length > 1 ? 's' : '' }}
                    ({{ running() }} de course{{ strength() ? ', ' + strength() + ' de renfo' : '' }}) sur {{ weeks() }} semaine{{ weeks() > 1 ? 's' : '' }},
                    du {{ short(p.sessions[0].date) }} au {{ short(p.sessions.at(-1)!.date) }}</li>
                  @if (!p.fenced) {
                    <li class="warn"><app-icon name="warning" /> Pas de bloc <code>runstat-plan</code> : lu depuis les tableaux du texte, vérifie l'aperçu.</li>
                  }
                  @if (replaced()) {
                    <li>↺ remplace {{ replaced() }} séance{{ replaced() > 1 ? 's' : '' }} du plan actuel sur ces dates</li>
                  }
                  @if (past()) {
                    <li class="warn"><app-icon name="warning" /> {{ past() }} séance{{ past() > 1 ? 's' : '' }} avant aujourd'hui</li>
                  }
                  @if (after()) {
                    <li class="warn"><app-icon name="warning" /> {{ after() }} séance{{ after() > 1 ? 's' : '' }} après {{ t.endLabel }} ({{ short(t.end) }})</li>
                  }
                  @if (p.ignored.length) {
                    <li class="warn"><app-icon name="warning" /> {{ p.ignored.length }} ligne{{ p.ignored.length > 1 ? 's' : '' }} ignorée{{ p.ignored.length > 1 ? 's' : '' }} :
                      <code class="ignored">{{ p.ignored.slice(0, 3).join(' · ') }}{{ p.ignored.length > 3 ? ' …' : '' }}</code></li>
                  }
                </ul>
                @if (effect(); as fx) {
                  <p class="effect">Indice {{ fx.before }} → <b>{{ fx.after }}</b> avec ce plan</p>
                }
              } @else {
                <p class="warn" role="alert">Aucune séance lue : il faut des lignes « date | type | nom | durée | distance | étapes | phase ».</p>
              }
            }
            @if (errors().length) {
              <ul class="form-errors" role="alert">
                @for (x of errors(); track $index) {
                  <li>{{ x }}</li>
                }
              </ul>
            }
          </div>
          <footer>
            <span class="spacer"></span>
            <button type="button" class="btn" (click)="close()">Annuler</button>
            <button type="submit" class="btn primary" [disabled]="!parsed().sessions.length || entries.saving()">{{ entries.saving() ? 'Enregistrement…' : 'Enregistrer le plan' }}</button>
          </footer>
        </form>
      }
    </dialog>
  `,
  styles: `
    .small { margin: 0; font-size: 0.85rem; }
    .file { justify-self: start; cursor: pointer; }
    .facts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; font-size: 0.88rem; }
    .warn { color: var(--warning); }
    li app-icon { vertical-align: -0.15em; --icon: 1em; }
    .ignored { font-size: 0.75rem; overflow-wrap: anywhere; }
    .effect { margin: 0; padding: 0.6rem 0.8rem; border-radius: var(--radius); background: var(--accent-soft); font-size: 0.95rem; }
  `,
})
export class PlanImportComponent {
  protected readonly entries = inject(EntriesService);
  private readonly sci = inject(ScienceService);
  private readonly today = isoDay(inject(PeriodService).today);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  readonly target = signal<PlanTarget | null>(null);
  protected readonly text = signal('');
  protected readonly errors = signal<string[]>([]);
  protected readonly short = short;

  protected readonly parsed = computed(() => parsePlanMarkdown(this.text()));
  protected readonly running = computed(() => this.parsed().sessions.filter((s) => s.kind !== 'strength').length);
  protected readonly strength = computed(() => this.parsed().sessions.filter((s) => s.kind === 'strength').length);
  protected readonly weeks = computed(() => {
    const s = this.parsed().sessions;
    return s.length ? Math.floor((parseDay(s.at(-1)!.date).getTime() - parseDay(s[0].date).getTime()) / 604_800_000) + 1 : 0;
  });
  protected readonly past = computed(() => this.parsed().sessions.filter((s) => s.date < this.today).length);
  protected readonly after = computed(() => this.parsed().sessions.filter((s) => s.date > (this.target()?.end ?? '9999')).length);
  protected readonly replaced = computed(() => {
    const s = this.parsed().sessions;
    const old = this.target()?.plan?.sessions ?? [];
    if (!s.length) return 0;
    return old.filter((o) => o.date >= s[0].date && o.date <= s.at(-1)!.date).length;
  });
  private readonly merged = computed(() => {
    const t = this.target();
    const s = this.parsed().sessions;
    return t && s.length ? mergePlan(t.plan ?? null, t.id, s) : null;
  });
  protected readonly effect = computed(() => {
    // Effet sur l'indice : seulement pour une course (un cycle n'a pas d'indice)
    const e = this.target()?.ev;
    const m = this.merged();
    if (!e || !m) return null;
    const next = this.sci.evaluate(e.goal, m);
    if (!next) return null;
    const fmt = (x: GoalEvaluation) => `${x.index}${x.probability !== null ? ' %' : '/100'}`;
    return { before: fmt(e), after: fmt(next) };
  });

  open(t: PlanTarget): void {
    this.target.set(t);
    this.text.set('');
    this.errors.set([]);
    const d = this.dlg().nativeElement;
    if (!d.open) d.showModal();
  }

  close(): void {
    this.dlg().nativeElement.close();
  }

  protected async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return this.errors.set(['Fichier trop volumineux (2 Mo au plus)']);
    this.text.set(await file.text());
    this.errors.set([]);
  }

  protected async save(): Promise<void> {
    const m = this.merged();
    if (!m) return;
    try {
      await this.entries.savePlan(m);
      this.close();
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }
}
