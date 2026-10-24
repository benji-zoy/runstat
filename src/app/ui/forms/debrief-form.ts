import { Component, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { DataService } from '../../core/data.service';
import { EntriesService } from '../../core/entries.service';
import { Goal, GoalDebriefNotes } from '../../core/models';
import { clock, parseDuration, parseKmList } from '../../core/format';
import { FormDialogComponent, durationHint, errorList } from './form-dialog';

/** Bilan d'une course terminée (Courses › Archives) : temps puce, gels, ressenti */
@Component({
  selector: 'app-debrief-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog [heading]="'Bilan · ' + (goal()?.name ?? '')" [errors]="errors()" [busy]="entries.saving()" (save)="save()">
      <div class="fields" [formGroup]="form">
        <label class="field">Temps puce (officiel)
          <input formControlName="chip" autofocus placeholder="1:36:56" autocomplete="off" />
          <span class="hint">{{ preview() }}</span>
        </label>
        <label class="field">Gels pris (km)
          <input formControlName="gels" placeholder="7, 14" autocomplete="off" inputmode="decimal" />
          <span class="hint">Kilomètres, ex. « 7, 14, 21,5 »</span>
        </label>
        <label class="field wide">Ressenti
          <textarea formControlName="notes" rows="6" placeholder="Une remarque par ligne : départ, passages difficiles, sommeil, matériel…"></textarea>
        </label>
      </div>
    </app-form-dialog>
  `,
})
export class DebriefFormComponent {
  protected readonly entries = inject(EntriesService);
  private readonly store = inject(DataService);
  private readonly dialog = viewChild.required(FormDialogComponent);

  protected readonly goal = signal<Goal | null>(null);
  protected readonly errors = signal<string[]>([]);
  protected readonly form = inject(FormBuilder).nonNullable.group({ chip: '', gels: '', notes: '' });

  open(goal: Goal): void {
    const d = goal.debrief;
    this.goal.set(goal);
    this.errors.set([]);
    this.form.reset({
      chip: d?.chipSec ? clock(d.chipSec) : '',
      gels: d?.gelsKm?.join(', ') ?? '',
      notes: d?.notes?.join('\n') ?? '',
    });
    this.dialog().open();
  }

  protected preview(): string {
    return durationHint(this.form.controls.chip.value, 'Celui des résultats officiels, s’il diffère de la montre');
  }

  protected async save(): Promise<void> {
    const goal = this.goal();
    if (!goal) return;
    const v = this.form.getRawValue();
    const chipSec = v.chip.trim() ? parseDuration(v.chip) : undefined;
    const gelsKm = v.gels.trim() ? parseKmList(v.gels) : [];
    const errors: string[] = [];
    if (chipSec === null) errors.push('Temps puce illisible (ex. 1:36:56)');
    if (gelsKm === null) errors.push('Gels : liste de kilomètres, ex. 7, 14');
    if (errors.length) return this.errors.set(errors);

    const notes = v.notes.split('\n').map((n) => n.trim()).filter(Boolean);
    const debrief: GoalDebriefNotes = {
      ...(chipSec ? { chipSec } : {}),
      ...(gelsKm?.length ? { gelsKm } : {}),
      ...(notes.length ? { notes } : {}),
    };
    const goals = (this.store.data()?.goals ?? []).map((g) =>
      g.id === goal.id ? { ...g, debrief: Object.keys(debrief).length ? debrief : undefined } : g,
    );
    try {
      await this.entries.saveGoals(goals);
      this.dialog().close();
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }
}
