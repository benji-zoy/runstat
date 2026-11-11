import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DataService } from '../../core/data.service';
import { EntriesService } from '../../core/entries.service';
import { Goal, GoalCourse } from '../../core/models';
import { clock, num, parseDuration } from '../../core/format';
import { parseGpx } from '../../core/course';
import { FormDialogComponent, durationHint, errorList, opt } from './form-dialog';

type Mode = 'finish' | 'time' | 'range';

const PRESETS = [
  { label: '5 km', km: 5 },
  { label: '10 km', km: 10 },
  { label: 'Semi', km: 21.0975 },
  { label: 'Marathon', km: 42.195 },
];

/** « Semi de Paris » le 2026-10-11 → semi-de-paris-2026-10 */
export function goalId(name: string, date: string, taken: string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'course';
  const id = `${base}-${date.slice(0, 7)}`;
  let out = id;
  for (let i = 2; taken.includes(out); i++) out = `${id}-${i}`;
  return out;
}

/** Ajout et modification d'un objectif (Courses) : distance, terrain, chrono visé ou « finir », lieu pour la météo */
@Component({
  selector: 'app-goal-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog [heading]="editing() ? 'Modifier l’objectif' : 'Nouvel objectif'" [errors]="errors()"
      [busy]="entries.saving()" (save)="save()">
      <div class="fields" [formGroup]="form">
        <label class="field wide">Nom de la course
          <input formControlName="name" required maxlength="80" autofocus placeholder="Semi-marathon de Paris" />
        </label>
        <label class="field">Date <input type="date" formControlName="date" required /></label>
        <label class="field">Heure de départ <input type="time" formControlName="startTime" /></label>

        <div class="field wide">Distance
          <div class="chips">
            @for (p of presets; track p.km) {
              <button type="button" class="chip" [class.active]="form.controls.distanceKm.value === p.km" (click)="form.controls.distanceKm.setValue(p.km)">{{ p.label }}</button>
            }
          </div>
        </div>
        <label class="field">Distance (km)
          <input type="number" formControlName="distanceKm" min="0.4" max="500" step="any" inputmode="decimal" required />
        </label>
        <div class="field">Terrain
          <div class="seg">
            <button type="button" [class.active]="form.controls.kind.value === 'road'" (click)="form.controls.kind.setValue('road')">Route</button>
            <button type="button" [class.active]="form.controls.kind.value === 'trail'" (click)="form.controls.kind.setValue('trail')">Trail</button>
          </div>
        </div>
        <label class="field">Dénivelé positif (m)
          <input type="number" formControlName="elevGain" min="0" step="10" inputmode="numeric" />
        </label>
        <label class="field">Dénivelé négatif (m)
          <input type="number" formControlName="elevLoss" min="0" step="10" inputmode="numeric" placeholder="= D+ si vide" />
        </label>

        <div class="field wide">Tracé GPX
          <div class="gpx">
            <label class="btn">{{ course() ? 'Remplacer le tracé' : 'Importer un GPX' }}
              <input type="file" accept=".gpx,application/gpx+xml" (change)="importGpx($event)" hidden />
            </label>
            @if (course(); as c) {
              <span class="hint">{{ c.file ?? 'Tracé' }} · {{ c.waypoints?.length ?? 0 }} point{{ (c.waypoints?.length ?? 0) > 1 ? 's' : '' }} de passage</span>
              <button type="button" class="btn" (click)="course.set(null); gpxNote.set('')">Retirer</button>
            }
          </div>
          <span class="hint">{{ gpxNote() || 'Le profil et les points de passage (ravitaillements) servent à la prédiction et aux temps de passage. Seul le profil est gardé, pas les coordonnées.' }}</span>
        </div>

        <div class="field wide">Objectif
          <div class="seg">
            <button type="button" [class.active]="mode() === 'finish'" (click)="mode.set('finish')">Finir</button>
            <button type="button" [class.active]="mode() === 'time'" (click)="mode.set('time')">Chrono</button>
            <button type="button" [class.active]="mode() === 'range'" (click)="mode.set('range')">Fourchette</button>
          </div>
        </div>
        @if (mode() !== 'finish') {
          <label class="field">Chrono visé
            <input formControlName="target" placeholder="1:35:00 ou 1h35" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.target.value) }}</span>
          </label>
        }
        @if (mode() === 'range') {
          <label class="field">Chrono ambitieux
            <input formControlName="stretch" placeholder="1:32:00" autocomplete="off" />
            <span class="hint">{{ preview(form.controls.stretch.value) }}</span>
          </label>
        }

        @if (mains().length) {
          <label class="field wide">Course de préparation pour
            <select formControlName="parent">
              <option value="">Aucune : objectif principal</option>
              @for (m of mains(); track m.id) {
                <option [value]="m.id">{{ m.name }} ({{ m.date }})</option>
              }
            </select>
            <span class="hint">Un objectif secondaire est intégré au plan d'entraînement de l'objectif principal.</span>
          </label>
        }

        <details class="field wide" [open]="form.controls.lat.value !== null">
          <summary>Lieu du départ (prévision météo)</summary>
          <div class="fields">
            <label class="field">Latitude <input type="number" formControlName="lat" step="any" min="-90" max="90" inputmode="decimal" placeholder="43.60" /></label>
            <label class="field">Longitude <input type="number" formControlName="lon" step="any" min="-180" max="180" inputmode="decimal" placeholder="1.44" /></label>
          </div>
          <span class="hint">Sans lieu : ton lieu de sortie habituel. Prévision disponible 15 jours avant.</span>
        </details>
      </div>
      @if (editing()) {
        <button danger type="button" class="btn danger" (click)="remove()" [disabled]="entries.saving()">Supprimer</button>
      }
    </app-form-dialog>
  `,
  styles: `
    .gpx { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    .gpx label.btn { cursor: pointer; }
  `,
})
export class GoalFormComponent {
  protected readonly entries = inject(EntriesService);
  private readonly store = inject(DataService);
  private readonly router = inject(Router);
  private readonly dialog = viewChild.required(FormDialogComponent);

  protected readonly presets = PRESETS;
  protected readonly editing = signal<Goal | null>(null);
  protected readonly mode = signal<Mode>('time');
  protected readonly errors = signal<string[]>([]);
  /** Profil du tracé importé (gardé tel quel à l'enregistrement) */
  protected readonly course = signal<GoalCourse | null>(null);
  protected readonly gpxNote = signal('');

  private readonly fb = inject(FormBuilder).nonNullable;
  protected readonly form = this.fb.group({
    name: '',
    date: '',
    startTime: '',
    distanceKm: this.fb.control<number | null>(null),
    kind: 'road' as 'road' | 'trail',
    elevGain: this.fb.control<number | null>(null),
    elevLoss: this.fb.control<number | null>(null),
    target: '',
    stretch: '',
    lat: this.fb.control<number | null>(null),
    lon: this.fb.control<number | null>(null),
    parent: '',
  });
  /** Après l'enregistrement d'un nouvel objectif : ouvrir sa fiche (faux depuis l'assistant de plan) */
  private navigate = true;
  private readonly date = signal('');

  /** Objectifs principaux possibles : ni secondaires, ni celui-ci, après la date choisie */
  protected readonly mains = computed(() => {
    const me = this.editing();
    const date = this.date();
    const goals = this.store.data()?.goals ?? [];
    const hasChildren = me && goals.some((g) => g.parent === me.id);
    if (hasChildren) return [];
    return goals.filter((g) => !g.parent && g.id !== me?.id && (!date || g.date > date)).sort((a, b) => a.date.localeCompare(b.date));
  });

  constructor() {
    this.form.controls.date.valueChanges.subscribe((d) => this.date.set(d));
  }

  /** Sans argument : nouvel objectif ; `parent` : nouvel objectif secondaire de cet objectif (sans quitter la page) */
  open(goal?: Goal, { parent }: { parent?: string } = {}): void {
    this.navigate = !parent;
    this.editing.set(goal ?? null);
    this.errors.set([]);
    this.course.set(goal?.course ?? null);
    this.gpxNote.set('');
    this.mode.set(!goal ? 'time' : goal.stretchSec ? 'range' : goal.targetSec ? 'time' : 'finish');
    this.form.reset({
      name: goal?.name ?? '',
      date: goal?.date ?? '',
      startTime: goal?.startTime ?? '',
      distanceKm: goal?.distanceKm ?? null,
      kind: goal?.kind ?? 'road',
      elevGain: goal?.elevGain ?? null,
      elevLoss: goal?.elevLoss ?? null,
      target: goal?.targetSec ? clock(goal.targetSec) : '',
      stretch: goal?.stretchSec ? clock(goal.stretchSec) : '',
      lat: goal?.lat ?? null,
      lon: goal?.lon ?? null,
      parent: goal?.parent ?? parent ?? '',
    });
    this.date.set(goal?.date ?? '');
    this.dialog().open();
  }

  /** Lecture du GPX sur l'appareil : profil compact, distance, D+ et D− (modifiables), départ pour la météo */
  protected async importGpx(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) return this.errors.set(['GPX trop volumineux (30 Mo au plus)']);
    try {
      const p = parseGpx(await file.text(), file.name);
      const c = this.form.controls;
      this.course.set(p.course);
      c.distanceKm.setValue(p.distanceKm);
      c.elevGain.setValue(p.gain);
      c.elevLoss.setValue(p.loss);
      if (p.gain / p.distanceKm > 15) c.kind.setValue('trail');
      if (p.start && c.lat.value === null && c.lon.value === null) {
        c.lat.setValue(p.start.lat);
        c.lon.setValue(p.start.lon);
      }
      this.errors.set([]);
      this.gpxNote.set(`Tracé lu : ${num(p.distanceKm, 1)} km, ${num(p.gain)} m D+, ${num(p.loss)} m D−. Remets la distance et le dénivelé officiels s'ils diffèrent : le profil s'y recale.`);
    } catch (e) {
      this.errors.set([e instanceof Error ? e.message : 'GPX illisible']);
    }
  }

  protected preview(text: string): string {
    return durationHint(text, "ex. 1:35:00, 1h35, 42'30");
  }

  protected async save(): Promise<void> {
    const v = this.form.getRawValue();
    const errors: string[] = [];
    if (!v.name.trim()) errors.push('Donne un nom à la course');
    if (!v.date) errors.push('Indique la date');
    if (!v.distanceKm || v.distanceKm < 0.4) errors.push('Indique la distance (km)');
    const target = this.mode() === 'finish' ? undefined : parseDuration(v.target);
    const stretch = this.mode() === 'range' ? parseDuration(v.stretch) : undefined;
    if (target === null) errors.push('Chrono visé illisible (ex. 1:35:00 ou 1h35)');
    if (stretch === null) errors.push('Chrono ambitieux illisible');
    if (target && stretch && stretch >= target) errors.push('Le chrono ambitieux doit être plus rapide que le chrono visé');
    if ((v.lat === null) !== (v.lon === null)) errors.push('Lieu : indique la latitude et la longitude');
    const main = v.parent ? (this.store.data()?.goals ?? []).find((g) => g.id === v.parent) : null;
    if (main && v.date && v.date >= main.date) errors.push(`Une course de préparation doit avoir lieu avant ${main.name}`);
    if (errors.length) return this.errors.set(errors);

    const goals = this.store.data()?.goals ?? [];
    const old = this.editing();
    const goal: Goal = {
      id: old?.id ?? goalId(v.name, v.date, goals.map((g) => g.id)),
      name: v.name.trim(),
      date: v.date,
      startTime: v.startTime || undefined,
      distanceKm: v.distanceKm!,
      elevGain: opt(v.elevGain),
      elevLoss: opt(v.elevLoss),
      targetSec: target ?? undefined,
      stretchSec: stretch ?? undefined,
      kind: v.kind,
      lat: opt(v.lat),
      lon: opt(v.lon),
      debrief: old?.debrief,
      course: this.course() ?? undefined,
      parent: v.parent || undefined,
    };
    await this.write(old ? goals.map((g) => (g.id === old.id ? goal : g)) : [...goals, goal], old ? null : goal.id);
  }

  protected async remove(): Promise<void> {
    const old = this.editing();
    if (!old || !confirm(`Supprimer l’objectif « ${old.name} » ?`)) return;
    // Ses objectifs secondaires redeviennent des objectifs principaux
    const rest = (this.store.data()?.goals ?? []).filter((g) => g.id !== old.id).map(({ parent, ...g }) => (parent && parent !== old.id ? { ...g, parent } : g));
    await this.write(rest, null);
    if (this.router.url.startsWith(`/courses/${old.id}`)) void this.router.navigate(['/courses'], { replaceUrl: true });
  }

  private async write(goals: Goal[], show: string | null): Promise<void> {
    try {
      await this.entries.saveGoals(goals);
      this.dialog().close();
      // Nouvel objectif : ouvrir sa fiche
      if (show && this.navigate) void this.router.navigate(['/courses', show]);
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }
}
