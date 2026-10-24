import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { nasOrigin } from '../../engine/backup/api';
import { AccountService, accountError } from '../core/account.service';
import { suggestPassphrase, passphraseProblem } from '../core/passphrase';
import { KNOWN_NAS, LOCAL_MODE } from '../core/runtime';

type Step = 'serveur' | 'accord' | 'passkey' | 'creer' | 'code' | 'deverrouiller' | 'fini' | 'indisponible';

/**
 * Arrivée d'un proche local-first (appli publique) :
 *   /rejoindre#nas=<adresse du NAS>&code=<invitation> : NAS vérifié, accord (données de santé), passkey, phrase de passe ;
 *   /connexion[#nas=…&lien=<code>] : autre appareil, par passkey ou lien de connexion, puis phrase de passe et restauration.
 * Le fragment (#…) n'est jamais envoyé au serveur de l'appli ; il est effacé de l'adresse dès sa lecture.
 */
@Component({
  selector: 'app-join',
  imports: [RouterLink],
  template: `
    <section class="card join">
      @switch (step()) {
        @case ('indisponible') {
          <h1>Lien incomplet</h1>
          <p>Ce lien ne contient pas d'invitation. Demande un nouveau lien à la personne qui héberge ton compte.</p>
          <a class="btn" routerLink="/aujourdhui">Retour</a>
        }
        @case ('serveur') {
          @if (mode === 'connexion' && !fromLink) {
            <h1>Me connecter</h1>
            <p>Sur un nouvel appareil : connecte-toi avec ta passkey (elle suit ton compte Apple, Google ou ton gestionnaire de mots de
              passe), puis saisis ta phrase de passe pour récupérer tes données.</p>
            <label class="field">Adresse du NAS
              <input [value]="nas()" (input)="nas.set($any($event.target).value)" placeholder="https://…" inputmode="url" autocomplete="url" />
            </label>
            <button type="button" class="btn primary" [disabled]="busy() || !validNas()" (click)="loginWithPasskey()">Me connecter avec ma passkey</button>
          } @else {
            <h1>Serveur inconnu</h1>
            <p>Ce lien {{ mode === 'rejoindre' ? 'ouvre un compte' : 'te connecte' }} sur un serveur que cette appli ne connaît pas :</p>
            <p class="host">{{ host() }}</p>
            <p>Continue seulement si la personne qui te l'a envoyé l'héberge elle-même. Sinon, ferme cette page.</p>
            <div class="actions">
              <button type="button" class="btn primary" (click)="trustServer()">Je connais ce serveur</button>
              <a class="btn" routerLink="/aujourdhui">Annuler</a>
            </div>
          }
        }
        @case ('accord') {
          <h1>Bienvenue sur RunStat</h1>
          <p>Tes sorties, ta forme et tes données de santé restent <b>sur cet appareil</b> : les calculs s'y font. Le serveur de
            <b>{{ host() }}</b> garde seulement une sauvegarde chiffrée avec ta phrase de passe, qu'il ne peut pas lire. Elle sert aussi à
            retrouver tes données sur un autre appareil.</p>
          <p class="muted">Seuls les services que tu choisis sont contactés depuis cet appareil (Strava, COROS, Google, et la météo
            Open-Meteo pour tes lieux de sortie, arrondis à 10 km). Aucun traceur, aucune publicité.</p>
          <label class="check">
            <input type="checkbox" [checked]="consent()" (change)="consent.set($any($event.target).checked)" />
            J'accepte que mes données d'entraînement et de santé soient traitées ainsi (je peux tout effacer à tout moment).
          </label>
          <button type="button" class="btn primary" [disabled]="!consent() || busy()" (click)="createPasskey()">Créer ma passkey</button>
          <p class="muted">Une passkey remplace le mot de passe : ton téléphone ou ton ordinateur te demande ton empreinte, ton visage ou
            ton code.</p>
        }
        @case ('creer') {
          <h1>Ta phrase de passe</h1>
          <p>Elle chiffre ta sauvegarde sur cet appareil, avant tout envoi. <b>Personne ne peut la retrouver</b>, ni le propriétaire du NAS,
            ni l'appli : note-la. Elle sera demandée sur chaque nouvel appareil.</p>
          <div class="field">Phrase de passe
            <input type="text" aria-label="Phrase de passe" [value]="pass()" (input)="pass.set($any($event.target).value)" autocomplete="new-password" spellcheck="false" />
            <button type="button" class="btn small" (click)="pass.set(suggest())">Proposer une phrase</button>
          </div>
          <label class="field">Confirme
            <input type="text" [value]="confirm()" (input)="confirm.set($any($event.target).value)" autocomplete="new-password" spellcheck="false" />
          </label>
          <label class="check">
            <input type="checkbox" [checked]="withRecovery()" (change)="withRecovery.set($any($event.target).checked)" />
            Créer aussi un code de secours (si j'oublie ma phrase de passe)
          </label>
          @if (problem(); as p) {
            <p class="hint">{{ p }}</p>
          }
          <button type="button" class="btn primary" [disabled]="busy() || !!problem()" (click)="create()">Chiffrer et sauvegarder</button>
        }
        @case ('code') {
          <h1>Ton code de secours</h1>
          <p>Il remplace la phrase de passe si tu l'oublies. Range-le hors de l'appareil (papier, gestionnaire de mots de passe) :
            il ne sera plus affiché.</p>
          <p class="host code">{{ recovery() }}</p>
          <button type="button" class="btn primary" (click)="step.set('fini')">Je l'ai noté</button>
        }
        @case ('deverrouiller') {
          <h1>Ta sauvegarde</h1>
          <p>Saisis ta phrase de passe pour déchiffrer ta sauvegarde sur cet appareil.</p>
          <label class="field">{{ useRecovery() ? 'Code de secours' : 'Phrase de passe' }}
            <input type="text" [value]="pass()" (input)="pass.set($any($event.target).value)" autocomplete="current-password" spellcheck="false" />
          </label>
          <div class="actions">
            <button type="button" class="btn primary" [disabled]="busy() || !pass().trim()" (click)="unlock()">Récupérer mes données</button>
            <button type="button" class="btn" (click)="useRecovery.set(!useRecovery())">{{ useRecovery() ? 'Utiliser ma phrase de passe' : 'J’ai oublié : code de secours' }}</button>
          </div>
        }
        @case ('fini') {
          <h1>C'est prêt</h1>
          <p>Ton compte est ouvert sur cet appareil{{ restored() ? ' et tes données sont récupérées' : '' }}. Ajoute RunStat à ton écran
            d'accueil pour l'avoir sous la main.</p>
          <a class="btn primary" routerLink="/aujourdhui">Commencer</a>
        }
      }
      @if (status(); as s) {
        <p class="muted" role="status">{{ s }}</p>
      }
      @if (errors().length) {
        <ul class="form-errors" role="alert">
          @for (e of errors(); track $index) {
            <li>{{ e }}</li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .join { max-width: 560px; margin: 1.5rem auto; display: grid; gap: 0.8rem; }
    .join h1 { margin: 0; font-family: var(--font-display); font-size: 1.6rem; }
    .join p { margin: 0; }
    .host { font: 600 0.95rem ui-monospace, monospace; overflow-wrap: anywhere; padding: 0.5rem 0.7rem; background: var(--surface-2); border-radius: var(--radius); }
    .code { font-size: 1.15rem; letter-spacing: 0.04em; user-select: all; }
    .check { display: flex; gap: 0.5rem; align-items: flex-start; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .field { display: grid; gap: 0.3rem; }
    .field .btn.small { justify-self: start; }
  `,
})
export class JoinPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly account = inject(AccountService);
  protected readonly mode: 'rejoindre' | 'connexion' = this.route.snapshot.data['mode'] ?? 'rejoindre';
  protected readonly step = signal<Step>('serveur');
  protected readonly nas = signal(KNOWN_NAS[0] ?? '');
  protected readonly consent = signal(false);
  protected readonly pass = signal('');
  protected readonly confirm = signal('');
  protected readonly withRecovery = signal(true);
  protected readonly useRecovery = signal(false);
  protected readonly recovery = signal<string | null>(null);
  protected readonly restored = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal<string | null>(null);
  protected readonly errors = signal<string[]>([]);
  protected fromLink = false;
  private code = '';
  protected readonly suggest = suggestPassphrase;
  protected readonly validNas = computed(() => nasOrigin(this.nas().trim()) != null);
  protected readonly host = computed(() => {
    try {
      return new URL(this.nas()).host;
    } catch {
      return this.nas();
    }
  });
  protected readonly problem = computed(() => passphraseProblem(this.pass()) ?? (this.confirm() && this.confirm() !== this.pass() ? 'les deux saisies diffèrent' : !this.confirm() ? 'confirme la phrase de passe' : null));

  ngOnInit(): void {
    if (!LOCAL_MODE) return void this.router.navigateByUrl('/aujourdhui');
    const frag = new URLSearchParams(this.route.snapshot.fragment ?? '');
    // Le code ne reste pas dans l'adresse (historique, capture d'écran, partage)
    if (this.route.snapshot.fragment) history.replaceState(history.state, '', location.pathname);
    const nas = frag.get('nas');
    if (nas) this.nas.set(nas);
    const origin = nas ? nasOrigin(nas) : null;
    if (this.mode === 'rejoindre') {
      this.code = frag.get('code') ?? '';
      if (!origin || !this.code) return this.step.set('indisponible');
      this.step.set(KNOWN_NAS.includes(origin) ? 'accord' : 'serveur');
    } else {
      this.code = frag.get('lien') ?? '';
      this.fromLink = Boolean(origin && this.code);
      if (this.fromLink) return KNOWN_NAS.includes(origin!) ? void this.redeem() : this.step.set('serveur');
      this.step.set('serveur');
    }
  }

  protected trustServer(): void {
    if (this.mode === 'rejoindre') this.step.set('accord');
    else void this.redeem();
  }

  private async run(label: string, fn: () => Promise<void>): Promise<void> {
    this.errors.set([]);
    this.busy.set(true);
    this.status.set(label);
    try {
      await fn();
    } catch (e) {
      this.errors.set(accountError(e).errors);
    } finally {
      this.busy.set(false);
      this.status.set(null);
    }
  }

  /** Après la connexion : restauration si une sauvegarde existe, sinon première phrase de passe */
  private async next(): Promise<void> {
    this.step.set((await this.account.hasBackup()) ? 'deverrouiller' : 'creer');
  }

  protected createPasskey(): Promise<void> {
    return this.run('Création de la passkey…', async () => {
      await this.account.join(this.nas(), this.code);
      await this.next();
    });
  }

  protected loginWithPasskey(): Promise<void> {
    return this.run('Connexion…', async () => {
      await this.account.login(this.nas().trim());
      await this.next();
    });
  }

  private redeem(): Promise<void> {
    return this.run('Connexion…', async () => {
      await this.account.redeemLink(this.nas(), this.code);
      await this.next();
    });
  }

  protected create(): Promise<void> {
    return this.run('Chiffrement et première sauvegarde…', async () => {
      const code = await this.account.create(this.pass(), this.withRecovery());
      this.pass.set('');
      this.confirm.set('');
      this.recovery.set(code);
      this.step.set(code ? 'code' : 'fini');
    });
  }

  protected unlock(): Promise<void> {
    return this.run('Déchiffrement et récupération…', async () => {
      await this.account.unlock(this.pass(), this.useRecovery() ? 'recovery' : 'passphrase');
      this.pass.set('');
      this.restored.set(true);
      this.step.set('fini');
    });
  }
}
