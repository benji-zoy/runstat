import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import { IconComponent } from '../icon';
import { parseDuration } from '../../core/format';

/**
 * Fenêtre de saisie commune (<dialog> natif : Échap ferme, focus piégé) : titre, champs projetés, erreurs, pied
 * Annuler / Enregistrer. Les champs portent leur propre [formGroup] (le contexte d'injection est celui du formulaire appelant).
 * Bouton facultatif à gauche du pied : élément projeté avec l'attribut `danger`.
 */
@Component({
  selector: 'app-form-dialog',
  imports: [IconComponent],
  template: `
    <dialog #dlg class="sheet" [attr.aria-label]="heading()" (close)="closed.emit()">
      <form novalidate (submit)="$event.preventDefault(); save.emit()">
        <header>
          <h2>{{ heading() }}</h2>
          <button type="button" class="icon-btn" (click)="close()" aria-label="Fermer"><app-icon name="close" /></button>
        </header>
        <div class="body">
          <ng-content />
          @if (errors().length) {
            <ul class="form-errors" role="alert">
              @for (e of errors(); track $index) {
                <li>{{ e }}</li>
              }
            </ul>
          }
        </div>
        <footer>
          <ng-content select="[danger]" />
          <span class="spacer"></span>
          <button type="button" class="btn" (click)="close()">Annuler</button>
          <button type="submit" class="btn primary" [disabled]="busy()">{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}</button>
        </footer>
      </form>
    </dialog>
  `,
})
export class FormDialogComponent {
  readonly heading = input.required<string>();
  readonly errors = input<string[]>([]);
  readonly busy = input(false);
  readonly save = output<void>();
  readonly closed = output<void>();
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  open(): void {
    const d = this.dlg().nativeElement;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('.body')?.scrollTo(0, 0);
  }

  close(): void {
    this.dlg().nativeElement.close();
  }
}

/** Erreurs d'un enregistrement refusé : messages du service, sinon message générique */
export function errorList(e: unknown): string[] {
  const errors = (e as { errors?: string[] })?.errors;
  return errors?.length ? errors : [`Enregistrement impossible (${(e as Error)?.message ?? 'erreur inconnue'})`];
}

/** Nombre facultatif d'un champ (vide → undefined) */
export const opt = (v: number | null | undefined): number | undefined => (v === null || v === undefined || Number.isNaN(v) ? undefined : v);

/** Relecture d'une durée saisie : « = 1 h 36 min 56 s », ou `empty` si le champ est vide */
export function durationHint(text: string, empty: string): string {
  if (!text.trim()) return empty;
  const sec = parseDuration(text);
  if (sec === null) return 'format non reconnu';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return '= ' + [h && `${h} h`, (m || (h && s)) && `${m} min`, s && `${s} s`].filter(Boolean).join(' ');
}
