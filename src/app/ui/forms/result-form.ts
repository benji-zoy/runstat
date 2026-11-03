import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { EntriesService } from '../../core/entries.service';
import { ScienceService } from '../../core/science.service';
import { DataService } from '../../core/data.service';
import { Activity, RaceResult } from '../../core/models';
import { clock, day, num, parseDuration } from '../../core/format';
import { parseDay } from '../../core/stats';
import { officialDistance } from '../../core/science';
import { FormDialogComponent, durationHint, errorList, opt } from './form-dialog';

/** Poids d'une course dans les prédictions (athlete.json › raceWeights) ; '' = automatique */
/** Distances officielles proposées (km) ; les autres se saisissent à la main */
const DISTANCES = [
  { value: '5', label: '5 km' },
  { value: '10', label: '10 km' },
  { value: '15', label: '15 km' },
  { value: '20', label: '20 km' },
  { value: '21.0975', label: 'Semi-marathon' },
  { value: '42.195', label: 'Marathon' },
];

const WEIGHTS = [
  { value: '', label: 'Automatique' },
  { value: '0', label: 'Ignorée (0)' },
  { value: '0.5', label: 'Réduit (0,5)' },
  { value: '1', label: 'Normal (1)' },
  { value: '1.5', label: 'Renforcé (1,5)' },
];

/**
 * Course officielle et son classement (fiche d'une sortie, Courses, Comprendre › classements) : temps officiel, effectifs et
 * rangs relevés sur la page de résultats de l'organisateur ou du chronométreur. Aucun nom d'autre coureur, jamais
 * bases.athle.fr. Une sortie qui a un classement, même à compléter, compte comme course (références, barème FFA).
 * `declare()` : choisir d'abord la sortie parmi les dernières.
 */
@Component({
  selector: 'app-result-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog [heading]="heading()" [errors]="errors()" [busy]="entries.saving()" (save)="save()">
      <div class="fields" [formGroup]="form">
        @if (picking()) {
          <label class="field wide">Sortie
            <select [value]="activity()?.id ?? ''" (change)="pick($any($event.target).value)">
              <option value="" disabled>Choisis la sortie de la course</option>
              @for (c of candidates(); track c.id) {
                <option [value]="c.id">{{ c.label }}</option>
              }
            </select>
          </label>
        }
        <p class="hint field wide">Recopie les chiffres de la page de résultats officielle (organisateur ou chronométreur). Seuls les
          effectifs sont gardés, pas les noms. Les résultats de bases.athle.fr ne sont pas réutilisables. Tout est facultatif
          sauf le nom de l'épreuve : complète plus tard si les résultats ne sont pas encore publiés.</p>
        <label class="field wide">Épreuve <input formControlName="event" required maxlength="120" autofocus /></label>
        <div class="fields wide">
          <label class="field">Distance officielle
            <select formControlName="distance">
              <option value="">Non précisée</option>
              @for (d of distances; track d.value) {
                <option [value]="d.value">{{ d.label }}</option>
              }
              <option value="autre">Autre distance…</option>
            </select>
            @if (activity(); as a) {
              <span class="hint">Montre : {{ num(a.distanceKm, 2) }} km</span>
            }
          </label>
          <label class="field">Temps officiel (puce)
            <input formControlName="official" placeholder="1:36:56" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.official.value, activity() ? 'Montre : ' + clock(activity()!.durationSec) : '') }}</span>
          </label>
        </div>
        <div class="fields wide">
          @if (form.controls.distance.value === 'autre') {
            <label class="field">Distance (km) <input type="number" formControlName="distanceKm" step="any" min="0.4" inputmode="decimal" /></label>
          }
          <label class="field">Temps pistolet
            <input formControlName="gun" placeholder="facultatif" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.gun.value, '') }}</span>
          </label>
          <label class="field">Format <input formControlName="course" maxlength="80" placeholder="parcours L, nocturne…" /></label>
          <label class="field">D+ (m) <input type="number" formControlName="elevGain" min="0" step="10" inputmode="numeric" /></label>
        </div>
        <div class="fields wide trio">
          <span class="row-label">Scratch</span>
          <label class="field">Rang <input type="number" formControlName="rank" min="1" inputmode="numeric" /></label>
          <label class="field">Arrivants <input type="number" formControlName="finishers" min="1" inputmode="numeric" /></label>
        </div>
        <div class="fields wide trio">
          <div class="seg row-label">
            <button type="button" [class.active]="form.controls.sex.value === 'M'" (click)="form.controls.sex.setValue('M')">Hommes</button>
            <button type="button" [class.active]="form.controls.sex.value === 'F'" (click)="form.controls.sex.setValue('F')">Femmes</button>
          </div>
          <label class="field">Rang <input type="number" formControlName="sexRank" min="1" inputmode="numeric" /></label>
          <label class="field">Arrivants <input type="number" formControlName="sexCount" min="1" inputmode="numeric" /></label>
        </div>
        <div class="fields wide trio">
          <label class="field row-label">Catégorie <input formControlName="category" maxlength="30" placeholder="SEM, M0H…" /></label>
          <label class="field">Rang <input type="number" formControlName="catRank" min="1" inputmode="numeric" /></label>
          <label class="field">Arrivants <input type="number" formControlName="catCount" min="1" inputmode="numeric" /></label>
        </div>

        <label class="field wide">Page des résultats <input type="url" formControlName="source" placeholder="https://… (facultatif)" /></label>
        <label class="field">Chronométreur <input formControlName="timing" maxlength="120" /></label>
        <label class="field">Poids dans les prédictions
          <select formControlName="weight">
            @for (w of weights; track w.value) {
              <option [value]="w.value">{{ w.label }}</option>
            }
          </select>
        </label>
        <label class="field wide">Note <textarea formControlName="note" rows="2" maxlength="1000"></textarea></label>
        <label class="field wide check"><input type="checkbox" formControlName="pending" /> Classement à compléter plus tard (résultats pas encore publiés ou relevés)</label>
      </div>
      @if (activity()?.result) {
        <button danger type="button" class="btn danger" (click)="remove()" [disabled]="entries.saving()">Retirer la course</button>
      }
    </app-form-dialog>
  `,
  styles: `
    .check { display: flex; align-items: center; gap: 0.5rem; font-weight: 400; }
    .trio { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); align-items: end; }
    span.row-label { font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); padding-bottom: 0.7rem; }
    .seg.row-label { justify-self: stretch; }
    .seg.row-label button { flex: 1; padding-inline: 0.4rem; }
    .check input { width: auto; min-height: 0; }
    p.hint { margin: 0; font-weight: 400; }
  `,
})
export class ResultFormComponent {
  protected readonly entries = inject(EntriesService);
  private readonly sci = inject(ScienceService);
  private readonly dialog = viewChild.required(FormDialogComponent);

  protected readonly weights = WEIGHTS;
  protected readonly distances = DISTANCES;
  protected readonly num = num;
  protected readonly clock = clock;
  protected readonly activity = signal<Activity | null>(null);
  protected readonly errors = signal<string[]>([]);
  /** Ouvert par `declare()` : la sortie se choisit dans le formulaire */
  protected readonly picking = signal(false);
  private readonly store = inject(DataService);

  /** Sorties candidates : les 150 dernières de plus de 3 km, sans classement */
  protected readonly candidates = computed(() =>
    this.store.activities()
      .filter((a) => !a.result && a.distanceKm >= 3)
      .slice(-150)
      .reverse()
      .map((a) => ({ id: a.id, label: `${day(parseDay(a.date))} · ${a.name || 'Sortie'} · ${num(a.distanceKm, 1)} km · ${clock(a.durationSec)}` })),
  );

  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly n = () => this.fb.control<number | null>(null);
  protected readonly form = this.fb.group({
    event: '',
    course: '',
    /** Distance de la liste, '' (non précisée) ou 'autre' (distanceKm) */
    distance: '',
    distanceKm: this.n(),
    elevGain: this.n(),
    official: '',
    gun: '',
    rank: this.n(),
    finishers: this.n(),
    sex: 'M' as 'M' | 'F',
    sexRank: this.n(),
    sexCount: this.n(),
    category: '',
    catRank: this.n(),
    catCount: this.n(),
    source: '',
    timing: '',
    note: '',
    pending: false,
    weight: '',
  });

  protected heading(): string {
    const a = this.activity();
    if (!a || (!a.result && this.picking())) return 'Déclarer une course officielle';
    return `${a.result ? 'Classement' : 'Course officielle'} · ${a.result?.event ?? a.name} (${day(parseDay(a.date))})`;
  }

  /** Déclarer une course : choisir la sortie, puis saisir ses informations */
  declare(): void {
    this.picking.set(true);
    this.activity.set(null);
    this.errors.set([]);
    this.form.reset({ sex: this.sci.athlete().sex });
    this.dialog().open();
  }

  protected pick(id: string): void {
    const a = this.store.activities().find((x) => x.id === id);
    if (a) this.load(a);
  }

  open(a: Activity): void {
    this.picking.set(false);
    this.load(a);
    this.dialog().open();
  }

  private load(a: Activity): void {
    const r = a.result;
    const w = this.sci.athlete().raceWeights?.[a.id];
    this.activity.set(a);
    this.errors.set([]);
    this.form.reset({
      event: r?.event ?? a.name,
      course: r?.course ?? '',
      ...this.distanceFields(a),
      elevGain: r?.elevGain ?? null,
      official: r?.officialSec ? clock(r.officialSec) : '',
      gun: r?.gunSec ? clock(r.gunSec) : '',
      rank: r?.rank ?? null,
      finishers: r?.finishers ?? null,
      sex: r?.sex ?? this.sci.athlete().sex,
      sexRank: r?.sexRank ?? null,
      sexCount: r?.sexCount ?? null,
      category: r?.category ?? '',
      catRank: r?.catRank ?? null,
      catCount: r?.catCount ?? null,
      source: r?.source ?? '',
      timing: r?.timing ?? '',
      note: r?.note ?? '',
      pending: r?.pending ?? false,
      weight: w === undefined ? '' : String(w),
    });
  }

  protected readonly preview = durationHint;

  /** Distance déjà saisie ; à défaut, celle de la liste la plus proche de la montre (± 4 %), sur route : à confirmer */
  private distanceFields(a: Activity): { distance: string; distanceKm: number | null } {
    const km = a.result ? a.result.distanceKm ?? null : a.kind === 'trail' ? null : officialDistance(a.distanceKm) / 1000;
    if (km === null) return { distance: '', distanceKm: null };
    const listed = DISTANCES.find((d) => Math.abs(Number(d.value) - km) < 0.05);
    if (listed) return { distance: listed.value, distanceKm: null };
    return a.result ? { distance: 'autre', distanceKm: km } : { distance: '', distanceKm: null };
  }

  protected async save(): Promise<void> {
    const a = this.activity();
    if (!a) return this.errors.set(['Choisis la sortie de la course']);
    const v = this.form.getRawValue();
    const official = v.official.trim() ? parseDuration(v.official) : undefined;
    const gun = v.gun.trim() ? parseDuration(v.gun) : undefined;
    const errors: string[] = [];
    if (!v.event.trim()) errors.push('Indique le nom de l’épreuve');
    if (v.source.trim() && !/^https?:\/\/\S+$/.test(v.source.trim())) errors.push('Adresse de la page des résultats illisible (https://…)');
    if (official === null) errors.push('Temps officiel illisible (ex. 1:36:56)');
    if (gun === null) errors.push('Temps pistolet illisible');
    if (errors.length) return this.errors.set(errors);

    const text = (s: string) => s.trim() || null;
    const num = (n: number | null) => opt(n) ?? null;
    const result: Omit<RaceResult, 'file'> = {
      event: v.event.trim(),
      course: text(v.course),
      distanceKm: v.distance === 'autre' ? num(v.distanceKm) : v.distance ? Number(v.distance) : null,
      elevGain: num(v.elevGain),
      officialSec: official ?? null,
      gunSec: gun ?? null,
      rank: num(v.rank),
      finishers: num(v.finishers),
      sex: v.sex,
      sexRank: num(v.sexRank),
      sexCount: num(v.sexCount),
      category: text(v.category),
      catRank: num(v.catRank),
      catCount: num(v.catCount),
      label: a.result?.label ?? null,
      source: text(v.source),
      timing: text(v.timing),
      fetchedAt: new Date().toLocaleDateString('sv-SE'),
      note: text(v.note),
      ...(v.pending ? { pending: true } : {}),
    };
    try {
      await this.entries.saveResult(a.id, result, a.result?.file);
      await this.saveWeight(a.id, v.weight);
      this.dialog().close();
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }

  protected async remove(): Promise<void> {
    const a = this.activity();
    if (!a?.result || !confirm(`Retirer « ${a.result.event} » des courses officielles (classement supprimé) ?`)) return;
    try {
      await this.entries.deleteResult(a.id, a.result.file);
      this.dialog().close();
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }

  /** Poids de la course dans les prédictions : réglage de l'athlète, écrit seulement s'il change */
  private async saveWeight(id: string, value: string): Promise<void> {
    const athlete = this.sci.athlete();
    const current = athlete.raceWeights?.[id];
    const next = value === '' ? undefined : Number(value);
    if (current === next) return;
    const { [id]: _, ...others } = athlete.raceWeights ?? {};
    await this.entries.saveAthlete({ ...athlete, raceWeights: next === undefined ? others : { ...others, [id]: next } });
  }
}
