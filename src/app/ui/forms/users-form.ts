import { Component, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Account, MeService } from '../../core/me.service';
import { FormDialogComponent, errorList } from './form-dialog';

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

type Row = ReturnType<UsersFormComponent['row']>;

/** Identifiant proposé à partir du nom : « Élise Martin » → elise-martin */
export function slugId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * Proches (bouton de l'en-tête, propriétaire par l'adresse Tailscale) : comptes hébergés sur le NAS, chacun reconnu par
 * son login Tailscale. Retirer un compte coupe son accès ; ses données restent sur le NAS.
 */
@Component({
  selector: 'app-users-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog heading="Proches" [errors]="errors()" [busy]="busy()" (save)="save()">
      <div class="fields">
        <p class="hint field wide">Chaque proche hébergé a ses propres données sur le NAS et n'y voit que les siennes. Il se connecte
          par l'adresse Tailscale du site, avec le compte Tailscale dont tu indiques le login ; partage-lui aussi le NAS dans la
          console Tailscale (Machines › Partager).</p>
        @for (g of rows(); track g; let i = $index) {
          <fieldset class="field wide account" [formGroup]="g">
            <legend>
              {{ g.controls.name.value || 'Nouveau compte' }}
              <span class="muted">· {{ g.controls.id.value || '…' }}{{ g.controls.role.value === 'owner' ? ' · toi' : '' }}
                {{ g.controls.mode.value === 'local' ? ' · local-first' : '' }}</span>
            </legend>
            <label class="field">Nom <input formControlName="name" maxlength="60" required (input)="suggestId(i)" /></label>
            @if (isNew(i)) {
              <label class="field">Identifiant <input formControlName="id" maxlength="32" pattern="[a-z0-9][a-z0-9-]*" required />
                <span class="hint">Minuscules, chiffres, tirets ; nom de son dossier, définitif</span>
              </label>
            }
            <label class="field wide">Login Tailscale
              <input formControlName="logins" placeholder="prenom@exemple.fr" [readonly]="g.controls.mode.value === 'local'" />
              <span class="hint">Adresse de son compte Tailscale ; plusieurs, séparées par des virgules</span>
            </label>
            @if (g.controls.role.value !== 'owner') {
              <button type="button" class="btn small" (click)="remove(i)">Retirer l'accès</button>
            }
          </fieldset>
        }
        <button type="button" class="btn field wide" (click)="add()">Ajouter un proche hébergé</button>
      </div>
    </app-form-dialog>
  `,
  styles: `
    .account { border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.8rem 0.8rem; display: grid; gap: 0.5rem;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .account legend { font-weight: 600; padding: 0 0.3rem; }
    .account .btn.small { justify-self: start; align-self: end; }
  `,
})
export class UsersFormComponent {
  private readonly meService = inject(MeService);
  private readonly dialog = viewChild.required(FormDialogComponent);
  private readonly fb = inject(FormBuilder).nonNullable;
  protected readonly errors = signal<string[]>([]);
  protected readonly busy = signal(false);
  /** Comptes ajoutés dans cette fenêtre : seuls à pouvoir choisir leur identifiant (nom du dossier sur le NAS) */
  private fresh = new WeakSet<Row>();
  /** Une ligne par compte (signal : l'appli est sans zone.js) */
  protected readonly rows = signal<Row[]>([]);

  /** Ligne de saisie d'un compte */
  row(a: Partial<Account> = {}) {
    return this.fb.group({
      id: a.id ?? '',
      name: a.name ?? '',
      role: (a.role ?? 'member') as Account['role'],
      mode: (a.mode ?? 'hosted') as Account['mode'],
      logins: (a.logins ?? []).join(', '),
    });
  }

  async open(): Promise<void> {
    this.errors.set([]);
    this.rows.set([]);
    try {
      const list = await this.meService.accounts();
      this.rows.set(list.map((a) => this.row(a)));
    } catch (e) {
      this.errors.set(errorList(e));
    }
    this.dialog().open();
  }

  protected isNew(i: number): boolean {
    return this.fresh.has(this.rows()[i]);
  }

  protected add(): void {
    const g = this.row();
    this.fresh.add(g);
    this.rows.update((r) => [...r, g]);
  }

  protected remove(i: number): void {
    this.rows.update((r) => r.filter((_, j) => j !== i));
  }

  /** Identifiant suivant le nom tant qu'il n'a pas été enregistré */
  protected suggestId(i: number): void {
    const g = this.rows()[i];
    if (this.fresh.has(g) && !g.controls.id.dirty) g.controls.id.setValue(slugId(g.controls.name.value));
  }

  protected async save(): Promise<void> {
    const list: Account[] = this.rows().map((g) => g.getRawValue()).map((r) => ({
      id: r.id.trim(),
      name: r.name.trim(),
      role: r.role,
      mode: r.mode,
      logins: r.logins.split(',').map((l) => l.trim()).filter(Boolean),
    }));
    const bad = list.filter((a) => !ID.test(a.id) || !a.name);
    if (bad.length) return this.errors.set(['Chaque compte a un nom et un identifiant (minuscules, chiffres, tirets)']);
    if (list.some((a) => a.mode === 'hosted' && !a.logins.length)) return this.errors.set(['Indique le login Tailscale de chaque proche hébergé']);
    this.busy.set(true);
    try {
      await this.meService.saveAccounts(list);
      this.dialog().close();
    } catch (e) {
      this.errors.set(errorList(e));
    } finally {
      this.busy.set(false);
    }
  }
}
