import { Component, computed, output, signal } from '@angular/core';
import { adviseSources, StravaPlan, Watch } from '../../core/sources-advice';
import { LOCAL_MODE } from '../../core/runtime';
import { ActivitySource, HealthSource } from '../../core/models';
import { HEALTH_LABELS, CAPABILITIES } from '../../core/sources';

const WATCHES: { id: Watch; label: string }[] = [
  { id: 'coros', label: 'COROS' },
  { id: 'garmin', label: 'Garmin' },
  { id: 'other', label: 'Autre ou aucune' },
];
const PLANS: { id: StravaPlan; label: string }[] = [
  { id: 'none', label: 'Pas de Strava' },
  { id: 'free', label: 'Gratuit' },
  { id: 'paid', label: 'Abonné' },
];

/** Assistant « Que choisir ? » des Réglages : trois questions, puis la meilleure source et la marche à suivre ; « Appliquer » ne
 * fait que remplir les sélecteurs du formulaire (rien n'est enregistré avant « Enregistrer ») */
@Component({
  selector: 'app-source-guide',
  template: `
    <details class="field wide guide">
      <summary>Que choisir ? Je te guide</summary>
      <div class="q">Ta montre
        <div class="seg">
          @for (w of watches; track w.id) {
            <button type="button" [class.active]="watch() === w.id" (click)="watch.set(w.id)">{{ w.label }}</button>
          }
        </div>
      </div>
      <div class="q">Ton compte Strava
        <div class="seg">
          @for (p of plans; track p.id) {
            <button type="button" [class.active]="strava() === p.id" (click)="strava.set(p.id)">{{ p.label }}</button>
          }
        </div>
      </div>
      <div class="q">Tu as des données Google Health (Fitbit, Pixel Watch) ?
        <div class="seg">
          <button type="button" [class.active]="!google()" (click)="google.set(false)">Non</button>
          <button type="button" [class.active]="google()" (click)="google.set(true)">Oui</button>
        </div>
      </div>
      <div class="advice">
        <p class="verdict"><b>{{ activityLabel() }}</b> pour les activités{{ advice().health === 'none' ? ', pas de source de santé' : ', ' + healthLabel() + ' pour la santé' }}.</p>
        <p class="hint">{{ advice().headline }}</p>
        <ol class="hint">
          @for (s of advice().steps; track s) {
            <li>{{ s }}</li>
          }
        </ol>
        @for (n of advice().notes; track n) {
          <p class="hint note">{{ n }}</p>
        }
        <button type="button" class="btn primary" (click)="apply.emit({ activities: advice().activities, health: advice().health })">Appliquer ce choix</button>
      </div>
    </details>
  `,
  styles: `
    .guide { border: 1px solid var(--border); border-radius: 10px; padding: 0.6rem 0.8rem; display: grid; gap: 0.7rem; }
    summary { cursor: pointer; font-weight: 600; color: var(--text-primary); }
    .q { display: grid; gap: 0.35rem; margin-top: 0.7rem; }
    .advice { display: grid; gap: 0.5rem; justify-items: start; padding-top: 0.7rem; border-top: 1px solid var(--border); }
    p { margin: 0; }
    .verdict { color: var(--text-primary); }
    ol { margin: 0; padding-left: 1.3rem; display: grid; gap: 0.3rem; line-height: 1.5; }
    .note { padding-left: 0.6rem; border-left: 2px solid var(--border); }
  `,
})
export class SourceGuideComponent {
  readonly apply = output<{ activities: ActivitySource; health: HealthSource }>();
  protected readonly watches = WATCHES;
  protected readonly plans = PLANS;
  protected readonly watch = signal<Watch>('coros');
  protected readonly strava = signal<StravaPlan>('none');
  protected readonly google = signal(false);
  protected readonly advice = computed(() =>
    adviseSources({ watch: this.watch(), strava: this.strava(), google: this.google(), local: LOCAL_MODE }));
  protected readonly activityLabel = computed(() => CAPABILITIES[this.advice().activities].label);
  protected readonly healthLabel = computed(() => HEALTH_LABELS[this.advice().health]);
}
