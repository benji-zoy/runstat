import { Component, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { EntriesService } from '../../core/entries.service';
import { ScienceService } from '../../core/science.service';
import { Activity, RaceResult } from '../../core/models';
import { clock, day, parseDuration } from '../../core/format';
import { parseDay } from '../../core/stats';
import { FormDialogComponent, durationHint, errorList, opt } from './form-dialog';

/** Poids d'une course dans les prédictions (athlete.json › raceWeights) ; '' = automatique */
const WEIGHTS = [
  { value: '', label: 'Automatique' },
  { value: '0', label: 'Ignorée (0)' },
  { value: '0.5', label: 'Réduit (0,5)' },
  { value: '1', label: 'Normal (1)' },
  { value: '1.5', label: 'Renforcé (1,5)' },
];

/**
 * Classement officiel d'une course (Courses › Classements) : effectifs et rangs relevés sur la page de résultats
 * de l'organisateur ou du chronométreur. Aucun nom d'autre coureur, jamais bases.athle.fr.
 */
@Component({
  selector: 'app-result-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog [heading]="'Classement · ' + title()" [errors]="errors()" [busy]="entries.saving()" (save)="save()">
      <div class="fields" [formGroup]="form">
        <p class="hint field wide">Recopie les chiffres de la page de résultats officielle (organisateur ou chronométreur). Seuls les
          effectifs sont gardés, pas les noms. Les résultats de bases.athle.fr ne sont pas réutilisables.</p>
        <label class="field wide">Épreuve <input formControlName="event" required maxlength="120" autofocus /></label>
        <div class="fields wide">
          <label class="field">Format <input formControlName="course" maxlength="80" placeholder="10 km, parcours L…" /></label>
          <label class="field">Distance officielle (km) <input type="number" formControlName="distanceKm" step="any" min="0.4" inputmode="decimal" /></label>
          <label class="field">D+ (m) <input type="number" formControlName="elevGain" min="0" step="10" inputmode="numeric" /></label>
        </div>
        <div class="fields wide">
          <label class="field">Temps officiel (puce)
            <input formControlName="official" placeholder="1:36:56" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.official.value, 'Prioritaire sur le temps de la montre') }}</span>
          </label>
          <label class="field">Temps pistolet
            <input formControlName="gun" placeholder="facultatif" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.gun.value, '') }}</span>
          </label>
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

        <label class="field wide">Page des résultats <input type="url" formControlName="source" required placeholder="https://…" /></label>
        <label class="field">Chronométreur <input formControlName="timing" maxlength="120" /></label>
        <label class="field">Poids dans les prédictions
          <select formControlName="weight">
            @for (w of weights; track w.value) {
              <option [value]="w.value">{{ w.label }}</option>
            }
          </select>
        </label>
        <label class="field wide">Note <textarea formControlName="note" rows="2" maxlength="1000"></textarea></label>
        <label class="field wide check"><input type="checkbox" formControlName="pending" /> À recopier plus tard (résultats pas encore relevés)</label>
      </div>
      @if (activity()?.result) {
        <button danger type="button" class="btn danger" (click)="remove()" [disabled]="entries.saving()">Supprimer</button>
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
  protected readonly activity = signal<Activity | null>(null);
  protected readonly errors = signal<string[]>([]);

  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly n = () => this.fb.control<number | null>(null);
  protected readonly form = this.fb.group({
    event: '',
    course: '',
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

  protected title(): string {
    const a = this.activity();
    return a ? `${a.result?.event ?? a.name} (${day(parseDay(a.date))})` : '';
  }

  open(a: Activity): void {
    const r = a.result;
    const w = this.sci.athlete().raceWeights?.[a.id];
    this.activity.set(a);
    this.errors.set([]);
    this.form.reset({
      event: r?.event ?? a.name,
      course: r?.course ?? '',
      distanceKm: r?.distanceKm ?? null,
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
    this.dialog().open();
  }

  protected readonly preview = durationHint;

  protected async save(): Promise<void> {
    const a = this.activity();
    if (!a) return;
    const v = this.form.getRawValue();
    const official = v.official.trim() ? parseDuration(v.official) : undefined;
    const gun = v.gun.trim() ? parseDuration(v.gun) : undefined;
    const errors: string[] = [];
    if (!v.event.trim()) errors.push('Indique le nom de l’épreuve');
    if (!/^https?:\/\/\S+$/.test(v.source.trim())) errors.push('Indique l’adresse de la page des résultats (https://…)');
    if (official === null) errors.push('Temps officiel illisible (ex. 1:36:56)');
    if (gun === null) errors.push('Temps pistolet illisible');
    if (errors.length) return this.errors.set(errors);

    const text = (s: string) => s.trim() || null;
    const num = (n: number | null) => opt(n) ?? null;
    const result: Omit<RaceResult, 'file'> = {
      event: v.event.trim(),
      course: text(v.course),
      distanceKm: num(v.distanceKm),
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
      source: v.source.trim(),
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
    if (!a?.result || !confirm(`Supprimer le classement de « ${a.result.event} » ?`)) return;
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
