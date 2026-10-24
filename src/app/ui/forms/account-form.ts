import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AccountService, accountError } from '../../core/account.service';
import { LocalService } from '../../core/local.service';
import { passphraseProblem, suggestPassphrase } from '../../core/passphrase';
import { IconComponent } from '../icon';

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'jamais');

/**
 * Compte et sauvegarde (appli publique, bouton de l'en-tête) : état de la sauvegarde chiffrée, sauvegarde immédiate, lien pour un
 * autre appareil, phrase de passe et code de secours, déconnexion. La phrase de passe ne sert que sur l'appareil.
 */
@Component({
  selector: 'app-account-form',
  imports: [RouterLink, IconComponent],
  template: `
    <dialog #dlg class="sheet" aria-label="Compte et sauvegarde">
      <form novalidate (submit)="$event.preventDefault()">
        <header>
          <h2>Compte et sauvegarde</h2>
          <button type="button" class="icon-btn" (click)="close()" aria-label="Fermer"><app-icon name="close" /></button>
        </header>
        <div class="body">
          @if (account.state(); as s) {
            <p>Compte <b>{{ s.user.name }}</b> sur <b>{{ host() }}</b>, cet appareil : {{ s.device.name }}.</p>
            @if (!s.token) {
              <p class="hint">Session expirée : reconnecte-toi avec ta passkey.</p>
              <a class="btn primary" routerLink="/connexion" (click)="close()">Me reconnecter</a>
            } @else if (!account.unlocked()) {
              <label class="field">Phrase de passe
                <input type="text" [value]="pass()" (input)="pass.set($any($event.target).value)" autocomplete="current-password" spellcheck="false" />
              </label>
              <button type="button" class="btn primary" [disabled]="busy() || !pass().trim()" (click)="unlock()">Déverrouiller la sauvegarde</button>
            } @else {
              <p class="hint">Dernière sauvegarde : {{ last() }}{{ account.syncing() ? ' · en cours…' : '' }}.
                Chiffrée sur cet appareil avant l'envoi : le serveur ne peut pas la lire. Automatique après chaque changement.</p>
              <div class="actions">
                <button type="button" class="btn primary" [disabled]="busy() || account.syncing()" (click)="syncNow()">Sauvegarder maintenant</button>
                <button type="button" class="btn" [disabled]="busy()" (click)="makeLink()">Lien pour un autre appareil</button>
              </div>
              @if (link(); as l) {
                <p class="hint">Valable 15 minutes, une seule fois, pour un appareil sans ta passkey (sinon, connecte-toi simplement avec elle) :</p>
                <code class="link">{{ l }}</code>
              }

              <h3 class="group">Phrase de passe</h3>
              @if (mode() === null) {
                <div class="actions">
                  <button type="button" class="btn" (click)="mode.set('phrase')">Changer la phrase de passe</button>
                  <button type="button" class="btn" (click)="mode.set('secours')">Nouveau code de secours</button>
                </div>
              } @else {
                <label class="field">Phrase de passe actuelle
                  <input type="text" [value]="pass()" (input)="pass.set($any($event.target).value)" autocomplete="current-password" spellcheck="false" />
                </label>
                @if (mode() === 'phrase') {
                  <div class="field">Nouvelle phrase de passe
                    <input type="text" aria-label="Nouvelle phrase de passe" [value]="next()" (input)="next.set($any($event.target).value)" autocomplete="new-password" spellcheck="false" />
                    <button type="button" class="btn small" (click)="next.set(suggest())">Proposer une phrase</button>
                    @if (next() && problem(); as p) {
                      <span class="hint">{{ p }}</span>
                    }
                  </div>
                }
                <div class="actions">
                  <button type="button" class="btn primary" [disabled]="busy() || !pass().trim() || (mode() === 'phrase' && !!problem())" (click)="apply()">
                    {{ mode() === 'phrase' ? 'Changer' : 'Créer le code' }}</button>
                  <button type="button" class="btn" (click)="mode.set(null)">Annuler</button>
                </div>
              }
              @if (recovery(); as code) {
                <p class="hint">Nouveau code de secours (l'ancien ne vaut plus rien) ; note-le hors de l'appareil :</p>
                <code class="link">{{ code }}</code>
              }
            }
            <button type="button" class="btn" (click)="logout()">Se déconnecter de cet appareil</button>
            <p class="hint">Les données restent sur l'appareil après la déconnexion ; la sauvegarde reste sur le serveur.</p>
          } @else {
            <p>Tes données sont sur cet appareil seulement. Pour les sauvegarder (chiffrées) et les retrouver ailleurs, il te faut une
              invitation de quelqu'un qui héberge RunStat.</p>
            <a class="btn primary" routerLink="/connexion" (click)="close()">J'ai déjà un compte : me connecter</a>
          }

          <h3 class="group">Mes données</h3>
          <div class="actions">
            <button type="button" class="btn" [disabled]="busy()" (click)="exportData()">Exporter mes données (zip)</button>
            @if (!erasing()) {
              <button type="button" class="btn danger" (click)="erasing.set(true)">Tout effacer…</button>
            }
          </div>
          @if (erasing()) {
            <p class="hint">
              @if (account.state()) {
                Efface ton compte sur <b>{{ host() }}</b> (sauvegarde, passkeys et sessions ; ta passkey est redemandée), puis toutes
                les données de cet appareil. Supprime ensuite la passkey « RunStat » de ton gestionnaire de mots de passe.
              } @else {
                Efface toutes les données de cet appareil.
              }
              Irréversible : exporte-les d'abord si tu veux les garder. Écris <b>EFFACER</b> pour confirmer.
            </p>
            <label class="field">Confirmation
              <input type="text" [value]="confirmText()" (input)="confirmText.set($any($event.target).value)" autocomplete="off" spellcheck="false" />
            </label>
            <div class="actions">
              <button type="button" class="btn danger" [disabled]="busy() || confirmText().trim() !== 'EFFACER'" (click)="erase()">Effacer définitivement</button>
              <button type="button" class="btn" (click)="erasing.set(false)">Annuler</button>
            </div>
          }
          <p class="hint"><a routerLink="/confidentialite" (click)="close()">Confidentialité : ce qui va où, tes droits</a></p>
          @if (message(); as m) {
            <p class="hint" role="status">{{ m }}</p>
          }
          @if (errors().length) {
            <ul class="form-errors" role="alert">
              @for (e of errors(); track $index) {
                <li>{{ e }}</li>
              }
            </ul>
          }
        </div>
      </form>
    </dialog>
  `,
  styles: `
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .field { display: grid; gap: 0.3rem; }
    .field .btn.small { justify-self: start; }
    p { margin: 0; }
    h3.group { margin: 0.4rem 0 0; padding-top: 0.8rem; border-top: 1px solid var(--border); font-size: 0.9rem; }
    code.link { display: block; overflow-wrap: anywhere; user-select: all; font: 600 0.8rem ui-monospace, monospace; padding: 0.5rem; background: var(--surface-2); border-radius: var(--radius); }
  `,
})
export class AccountFormComponent {
  protected readonly account = inject(AccountService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  protected readonly pass = signal('');
  protected readonly next = signal('');
  protected readonly mode = signal<'phrase' | 'secours' | null>(null);
  protected readonly link = signal<string | null>(null);
  protected readonly recovery = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly errors = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly erasing = signal(false);
  protected readonly confirmText = signal('');
  private readonly local = inject(LocalService);
  protected readonly suggest = suggestPassphrase;
  protected readonly problem = computed(() => passphraseProblem(this.next()));
  protected readonly host = computed(() => {
    const nas = this.account.state()?.nas;
    return nas ? new URL(nas).host : '';
  });
  protected readonly last = computed(() => when(this.account.state()?.lastSync));

  open(): void {
    this.reset();
    const d = this.dlg().nativeElement;
    if (!d.open) d.showModal();
  }

  close(): void {
    this.reset();
    this.dlg().nativeElement.close();
  }

  private reset(): void {
    this.pass.set('');
    this.next.set('');
    this.mode.set(null);
    this.link.set(null);
    this.recovery.set(null);
    this.message.set(null);
    this.errors.set([]);
    this.erasing.set(false);
    this.confirmText.set('');
  }

  private async run(fn: () => Promise<string | void>): Promise<void> {
    this.errors.set([]);
    this.message.set(null);
    this.busy.set(true);
    try {
      const m = await fn();
      if (m) this.message.set(m);
    } catch (e) {
      this.errors.set(accountError(e).errors);
    } finally {
      this.busy.set(false);
    }
  }

  protected unlock(): Promise<void> {
    return this.run(async () => {
      const r = await this.account.unlock(this.pass());
      this.pass.set('');
      return `Sauvegarde déverrouillée (${r.downloaded} fichier${r.downloaded > 1 ? 's' : ''} récupéré${r.downloaded > 1 ? 's' : ''}).`;
    });
  }

  protected syncNow(): Promise<void> {
    return this.run(async () => {
      const r = await this.account.sync();
      return `Version ${r.version} : ${r.uploaded} envoyé${r.uploaded > 1 ? 's' : ''}, ${r.downloaded} reçu${r.downloaded > 1 ? 's' : ''}.`;
    });
  }

  protected makeLink(): Promise<void> {
    return this.run(async () => {
      this.link.set(await this.account.deviceLink(new URL('.', document.baseURI).href));
    });
  }

  protected apply(): Promise<void> {
    return this.run(async () => {
      if (this.mode() === 'phrase') {
        await this.account.changePassphrase(this.pass(), this.next());
        this.mode.set(null);
        this.pass.set('');
        this.next.set('');
        return 'Phrase de passe changée. Elle sera demandée sur tes autres appareils à leur prochaine connexion.';
      }
      this.recovery.set(await this.account.newRecoveryCode(this.pass()));
      this.mode.set(null);
      this.pass.set('');
      return undefined;
    });
  }

  /** Export (RGPD, portabilité) : tout ce qui est sur l'appareil, sans les jetons */
  protected exportData(): Promise<void> {
    return this.run(async () => {
      const blob = await this.local.exportZip();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `runstat-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      return `Export prêt (${Math.max(1, Math.round(blob.size / 1024))} Ko).`;
    });
  }

  /** Effacement : compte sur le NAS (s'il y en a un), puis données de l'appareil, puis rechargement */
  protected erase(): Promise<void> {
    return this.run(async () => {
      if (this.account.state()?.token) await this.account.deleteAccount();
      else if (this.account.state()) await this.account.logout();
      await this.local.wipe();
      sessionStorage.clear();
      location.assign(new URL('aujourdhui', document.baseURI).href);
    });
  }

  protected logout(): Promise<void> {
    return this.run(async () => {
      await this.account.logout();
      return 'Déconnecté de cet appareil.';
    });
  }
}
