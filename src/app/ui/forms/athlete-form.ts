import { Component, computed, inject, signal, viewChild } from '@angular/core';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { EntriesService } from '../../core/entries.service';
import { ScienceService } from '../../core/science.service';
import { SyncService } from '../../core/sync.service';
import { MeService } from '../../core/me.service';
import { AccountService } from '../../core/account.service';
import { DeviceSyncService, type DeviceSource } from '../../core/device-sync.service';
import { LOCAL_MODE } from '../../core/runtime';
import { ActivitySource, Athlete, HealthSource } from '../../core/models';
import { CITY_NAMES, DEFAULT_CITY } from '../../core/equivalences';
import { FormDialogComponent, errorList, opt } from './form-dialog';

const ACTIVITY_SOURCES: { id: ActivitySource; label: string }[] = [
  { id: 'coros', label: 'COROS' },
  { id: 'strava', label: 'Strava' },
];
const HEALTH_SOURCES: { id: HealthSource; label: string }[] = [
  { id: 'google', label: 'Google Health' },
  { id: 'coros', label: 'COROS' },
  { id: 'none', label: 'Aucune' },
];

const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Réglages (bouton de l'en-tête) : FC, seuils, sexe, poids, taille, naissance, sources des données, connexion et archive Strava */
@Component({
  selector: 'app-athlete-form',
  imports: [ReactiveFormsModule, FormDialogComponent],
  template: `
    <app-form-dialog heading="Réglages" [errors]="errors()" [busy]="entries.saving()" (save)="save()">
      <div class="fields" [formGroup]="form">
        @if (me.me(); as m) {
          @if (m.multi) {
            <p class="hint field wide">Compte : <b>{{ m.name }}</b> ({{ m.id }}){{ m.role === 'owner' ? ', propriétaire' : '' }}.
              Ces réglages et tes sources ne concernent que ton compte.</p>
          }
        }
        <label class="field">FC max (bpm) <input type="number" formControlName="hrMax" autofocus min="120" max="230" inputmode="numeric" required /></label>
        <label class="field">FC de repos (bpm) <input type="number" formControlName="hrRest" min="25" max="110" inputmode="numeric" required /></label>
        <label class="field">Seuil 1 (bpm)
          <input type="number" formControlName="lt1Hr" min="80" max="230" inputmode="numeric" [placeholder]="auto(0.8)" />
          <span class="hint">Facultatif : 80 % de la FC max</span>
        </label>
        <label class="field">Seuil 2 (bpm)
          <input type="number" formControlName="lt2Hr" min="80" max="230" inputmode="numeric" [placeholder]="auto(0.89)" />
          <span class="hint">Facultatif : 89 % de la FC max</span>
        </label>
        <div class="field">Sexe
          <div class="seg">
            <button type="button" [class.active]="form.controls.sex.value === 'M'" (click)="form.controls.sex.setValue('M')">Homme</button>
            <button type="button" [class.active]="form.controls.sex.value === 'F'" (click)="form.controls.sex.setValue('F')">Femme</button>
          </div>
        </div>
        <label class="field">Date de naissance <input type="date" formControlName="birthday" required /></label>
        <label class="field">Poids (kg) <input type="number" formControlName="weightKg" min="25" max="250" step="0.1" inputmode="decimal" required /></label>
        <label class="field">Taille (cm) <input type="number" formControlName="heightCm" min="100" max="250" inputmode="numeric" required /></label>
        <label class="field">Ville de départ
          <select formControlName="homeCity">
            @for (c of cities; track c) {
              <option [value]="c">{{ c }}</option>
            }
          </select>
          <span class="hint">Point de départ des trajets des équivalences (Souvenirs)</span>
        </label>
        <p class="hint field wide">Changer la FC max, la FC de repos ou les seuils recalcule les zones de toutes tes sorties {{ local ? 'sur cet appareil' : 'sur le NAS' }}
          (quelques minutes) ; le reste s'applique tout de suite.</p>

        <h3 class="field wide group">Sources des données</h3>
        <div class="field">Activités
          <div class="seg">
            @for (s of activitySources; track s.id) {
              <button type="button" [class.active]="form.controls.activities.value === s.id" (click)="form.controls.activities.setValue(s.id)">{{ s.label }}</button>
            }
          </div>
        </div>
        <div class="field wide">Santé et sommeil
          <div class="seg">
            @for (s of healthSources; track s.id) {
              <button type="button" [class.active]="form.controls.health.value === s.id" (click)="form.controls.health.setValue(s.id)">{{ s.label }}</button>
            }
          </div>
        </div>
        @if (local && account.connected() && sync.available()) {
          <div class="field wide">Appareil de synchro
            <span class="hint">{{ device.isPrimary() ? 'Cet appareil synchronise tes sources et renouvelle les jetons ; tes autres appareils reçoivent les données par ta sauvegarde.'
              : 'Synchro faite par ' + device.primary()?.name + ' : ici, les données arrivent par ta sauvegarde.' }}</span>
            @if (!device.isPrimary()) {
              <div class="upload">
                <button type="button" class="btn" [disabled]="busy()" (click)="takeOver()">Devenir l’appareil principal</button>
              </div>
            }
          </div>
        }
        @if (usesCoros()) {
          <div class="field wide">Connexion COROS
            <span class="hint">{{ corosConnection() }}</span>
            <div class="upload">
              <a class="btn primary" [attr.href]="local ? '#' : connectUrl('coros')" (click)="go($event, 'coros')">{{ sync.status()?.corosConnected ? 'Reconnecter COROS' : 'Connecter COROS' }}</a>
            </div>
            <span class="hint">COROS te demande d’autoriser RunStat à lire tes activités et ta santé ; tu reviens ensuite ici.
              Une seule connexion à la fois : le jeton COROS change à chaque renouvellement.</span>
          </div>
        }
        @if (form.controls.health.value === 'google') {
          <div class="field wide">Connexion Google Health
            <span class="hint">{{ googleConnection() }}</span>
            @if (sync.status()?.googleClient) {
              <div class="upload">
                <a class="btn primary" [attr.href]="local ? '#' : connectUrl('google')" (click)="go($event, 'google')">{{ sync.status()?.googleConnected ? 'Reconnecter Google' : 'Connecter Google' }}</a>
              </div>
              <span class="hint">Passe par l’appli Google Cloud du propriétaire : il doit t’y avoir ajouté comme testeur, et y avoir
                déclaré l’adresse de retour <code>{{ local ? device.redirect('google') : stravaOrigin() + '/api/google/callback' }}</code>.
                En mode test, Google redemande l’autorisation chaque semaine.</span>
            }
          </div>
        }
        @if (form.controls.activities.value === 'strava') {
          <div class="field wide">Synchro Strava
            <span class="hint">{{ stravaConnection() }}</span>
            @if (!sync.status()?.stravaClient || editingClient()) {
              <span class="hint">Pour la synchro automatique, il te faut ta propre « appli » Strava (5 minutes, une seule fois).
                Strava la réserve aux comptes abonnés : sans abonnement, importe plutôt ton archive, plus bas.</span>
              <ol class="steps hint">
                <li>Ouvre <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>
                  (connecte-toi à ton compte Strava si besoin).</li>
                <li>Remplis le formulaire : nom <code>RunStat</code>, catégorie au choix (par exemple « Visualizer »),
                  site web <code>{{ stravaOrigin() }}</code>, et surtout « Authorization Callback Domain » :
                  <code>{{ callbackDomain() }}</code>
                  @if (canCopy) {
                    <button type="button" class="btn small" (click)="copy(callbackDomain())">{{ copied() ? 'Copié' : 'Copier' }}</button>
                  }
                </li>
                <li>Accepte les conditions et valide. Si Strava demande une icône, n’importe quelle image convient.</li>
                <li>Sur la page de ton appli, copie ici le « Client ID » et le « Client Secret » (affiche-le avec « Show »).</li>
              </ol>
              <div class="client" (keydown.enter)="$event.preventDefault(); saveClient()">
                <input type="text" [formControl]="clientId" inputmode="numeric" autocomplete="off" placeholder="Client ID" aria-label="Client ID" />
                <input type="password" [formControl]="clientSecret" autocomplete="off" placeholder="Client Secret" aria-label="Client Secret" />
                <button type="button" class="btn" [disabled]="entries.saving()" (click)="saveClient()">Enregistrer l’appli</button>
                @if (sync.status()?.stravaClient) {
                  <button type="button" class="btn" (click)="editingClient.set(false)">Annuler</button>
                }
              </div>
              <span class="hint">{{ local ? 'Ils restent sur cet appareil (et dans ta sauvegarde chiffrée)' : 'Ils restent sur le NAS' }} et ne s’affichent plus ensuite.</span>
            } @else {
              <div class="upload">
                <a class="btn primary" [attr.href]="local ? '#' : connectUrl('strava')" (click)="go($event, 'strava')">{{ sync.status()?.stravaConnected ? 'Reconnecter Strava' : 'Connecter Strava' }}</a>
                <button type="button" class="btn" (click)="editClient()">Changer d’appli</button>
              </div>
              <span class="hint">Strava te demande d’autoriser RunStat à lire tes sorties : laisse les cases cochées
                (sinon tes sorties privées ne seront pas synchronisées) et valide ; tu reviens ensuite ici.</span>
            }
            @if (!sync.status()?.stravaClient) {
              <div class="upload">
                <span class="btn primary disabled" aria-disabled="true">Connecter Strava</span>
                <span class="hint">Enregistre d’abord ton appli Strava.</span>
              </div>
            }
          </div>
          <div class="field wide">Archive Strava
            <span class="hint">Pour tout l'historique : sur strava.com, Paramètres › Mon compte › Télécharger ou supprimer ton compte ›
              Demander une archive. Le zip arrive par e-mail quelques heures plus tard ; {{ local ? 'choisis-le ici tel quel : il est lu sur l’appareil et n’est jamais envoyé.' : 'envoie-le ici tel quel.' }}</span>
            <div class="upload">
              <label class="btn" [class.disabled]="entries.uploading() !== null || sync.running()">
                <input type="file" accept=".zip,application/zip" hidden (change)="upload($event)"
                  [disabled]="entries.uploading() !== null || sync.running()" />
                {{ entries.uploading() !== null ? (local ? 'Import…' : 'Envoi…') : 'Importer l’archive' }}
              </label>
              @if (entries.uploading() !== null) {
                <progress [value]="entries.uploading()" max="1" aria-label="Envoi de l’archive"></progress>
                <span class="hint">{{ pct(entries.uploading()!) }} %</span>
              }
            </div>
            <span class="hint">{{ uploadNotice() ?? stravaStatus() }}</span>
          </div>
        }
        <p class="hint field wide">Changer de source reconstruit toutes les données {{ local ? 'sur cet appareil' : 'sur le NAS' }} (quelques minutes).</p>
      </div>
    </app-form-dialog>
  `,
  styles: `
    p.hint { margin: 0; font-weight: 400; }
    h3.group { margin: 0.6rem 0 0; padding-top: 0.8rem; border-top: 1px solid var(--border); font-size: 0.9rem; color: var(--text-primary); }
    .upload { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .btn.disabled { opacity: 0.55; pointer-events: none; }
    a.btn { text-decoration: none; }
    .client { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .client input { flex: 1 1 9rem; min-width: 0; }
    .steps { margin: 0.2rem 0; padding-left: 1.3rem; display: grid; gap: 0.35rem; line-height: 1.5; }
    .steps a { color: var(--accent); }
    .steps code { padding: 0.05rem 0.35rem; border-radius: 5px; background: var(--surface-2); color: var(--text-primary);
      font: 600 0.82rem ui-monospace, monospace; user-select: all; overflow-wrap: anywhere; }
    .steps .btn.small { min-height: 26px; padding: 0.1rem 0.55rem; margin-left: 0.3rem; vertical-align: middle; }
    progress { flex: 1; min-width: 120px; accent-color: var(--accent); }
  `,
})
export class AthleteFormComponent {
  protected readonly entries = inject(EntriesService);
  private readonly sci = inject(ScienceService);
  protected readonly sync = inject(SyncService);
  protected readonly me = inject(MeService);
  protected readonly account = inject(AccountService);
  protected readonly device = inject(DeviceSyncService);
  /** Appli publique : données et synchro sur l'appareil, connexions OAuth depuis le navigateur */
  protected readonly local = LOCAL_MODE;
  protected readonly busy = signal(false);
  protected readonly activitySources = ACTIVITY_SOURCES;
  protected readonly healthSources = HEALTH_SOURCES;
  protected readonly cities = CITY_NAMES;
  protected readonly uploadNotice = signal<string | null>(null);
  protected readonly pct = (p: number) => Math.round(p * 100);
  private readonly dialog = viewChild.required(FormDialogComponent);
  protected readonly errors = signal<string[]>([]);
  /** Adresse du site pour la connexion Strava (Tailscale Serve sur le NAS), sinon l'adresse courante */
  protected readonly stravaOrigin = computed(() => this.sync.status()?.stravaOrigin ?? location.origin);
  /** Domaine de rappel à déclarer dans l'appli Strava */
  protected readonly callbackDomain = computed(() => new URL(this.stravaOrigin()).hostname);
  /** Toujours par cette adresse (Tailscale), même depuis le réseau local : adresse de retour déclarée chez chaque service */
  protected connectUrl(source: 'strava' | 'coros' | 'google' = 'strava'): string {
    return `${this.stravaOrigin()}/api/${source}/connect`;
  }
  /** Valeurs du formulaire (pas des signaux) : relues à chaque rendu */
  protected usesCoros(): boolean {
    return this.form.controls.activities.value === 'coros' || this.form.controls.health.value === 'coros';
  }
  /** État des jetons COROS et Google du compte (sur le NAS) */
  protected readonly corosConnection = computed(() => {
    const st = this.sync.status();
    if (st?.state.coros?.reauthSince || st?.state.corosHealth?.reauthSince) return 'À ré-autoriser : COROS a refusé les jetons, reconnecte-toi.';
    return st?.corosConnected ? 'Connecté.' : 'Non connecté.';
  });
  protected readonly googleConnection = computed(() => {
    const st = this.sync.status();
    if (this.local && !st?.googleClient) return 'Indisponible sans compte : Google Health passe par le NAS qui t’héberge (lien d’invitation).';
    if (!st?.googleClient) return 'Indisponible : le propriétaire n’a pas déposé d’appli Google Cloud sur le NAS.';
    if (st.state.google?.reauthSince) return 'À ré-autoriser : Google a refusé les jetons (chaque semaine en mode test), reconnecte-toi.';
    return st.googleConnected ? 'Connecté.' : 'Non connecté.';
  });
  /** Presse-papiers : HTTPS ou localhost seulement */
  protected readonly canCopy = Boolean(navigator.clipboard) && isSecureContext;
  protected readonly copied = signal(false);
  protected readonly editingClient = signal(false);
  protected readonly clientId = new FormControl('', { nonNullable: true });
  protected readonly clientSecret = new FormControl('', { nonNullable: true });

  private readonly fb = inject(FormBuilder).nonNullable;
  private readonly n = () => this.fb.control<number | null>(null);
  protected readonly form = this.fb.group({
    hrMax: this.n(),
    hrRest: this.n(),
    lt1Hr: this.n(),
    lt2Hr: this.n(),
    sex: 'M' as 'M' | 'F',
    birthday: '',
    weightKg: this.n(),
    heightCm: this.n(),
    homeCity: DEFAULT_CITY,
    activities: 'coros' as ActivitySource,
    health: 'google' as HealthSource,
  });

  /** État de la connexion à l'API Strava (jetons sur le NAS) */
  protected readonly stravaConnection = computed(() => {
    const st = this.sync.status();
    if (!st?.stravaClient) return 'Non connectée : aucune appli Strava enregistrée.';
    if (!st.stravaConnected) return 'Non connectée.';
    if (st.state.strava?.reauthSince) return 'À ré-autoriser : Strava a refusé les jetons, reconnecte-toi.';
    return `Connectée${st.stravaAthlete ? ` (${st.stravaAthlete})` : ''}.`;
  });

  /** Dernière synchro Strava et dernière archive importée (sync-state.json) */
  protected readonly stravaStatus = computed(() => {
    const st = this.sync.status()?.state;
    const parts: string[] = [];
    if (st?.stravaArchive) parts.push(`Archive importée le ${when(st.stravaArchive.importedAt)} (${st.stravaArchive.runs} sorties)`);
    if (st?.strava?.lastSuccess) parts.push(`synchro Strava ${when(st.strava.lastSuccess)}`);
    else if (st?.strava?.reauthSince) parts.push('synchro Strava à ré-autoriser');
    return parts.length ? parts.join(' · ') : 'Aucune archive importée pour l’instant.';
  });

  open(): void {
    const a = this.sci.athlete();
    const src = this.sci.sources();
    this.errors.set([]);
    this.uploadNotice.set(null);
    this.editingClient.set(false);
    this.clientId.reset();
    this.clientSecret.reset();
    this.form.reset({
      hrMax: a.hrMax,
      hrRest: a.hrRest,
      lt1Hr: a.lt1Hr ?? null,
      lt2Hr: a.lt2Hr ?? null,
      sex: a.sex,
      birthday: a.birthday,
      weightKg: a.weightKg,
      heightCm: a.heightCm,
      homeCity: a.homeCity && CITY_NAMES.includes(a.homeCity) ? a.homeCity : DEFAULT_CITY,
      activities: src.activities,
      health: src.health,
    });
    this.dialog().open();
  }

  protected auto(share: number): string {
    const max = this.form.controls.hrMax.value;
    return max ? String(Math.round(share * max)) : '';
  }

  protected async save(): Promise<void> {
    const v = this.form.getRawValue();
    const missing = (['hrMax', 'hrRest', 'weightKg', 'heightCm'] as const).filter((k) => opt(v[k]) === undefined);
    if (missing.length || !v.birthday) return this.errors.set(['Renseigne FC max, FC de repos, naissance, poids et taille']);
    const athlete: Athlete = {
      ...this.sci.athlete(),
      hrMax: v.hrMax!,
      hrRest: v.hrRest!,
      lt1Hr: opt(v.lt1Hr),
      lt2Hr: opt(v.lt2Hr),
      sex: v.sex,
      birthday: v.birthday,
      weightKg: v.weightKg!,
      heightCm: v.heightCm!,
      homeCity: v.homeCity,
    };
    const sources = { activities: v.activities, health: v.health };
    const old = this.sci.sources();
    try {
      await this.entries.saveAthlete(athlete);
      if (sources.activities !== old.activities || sources.health !== old.health) await this.entries.saveSources(sources);
      this.dialog().close();
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {}
  }

  /** Connexion à une source : lien vers le NAS, ou autorisation lancée depuis l'appareil (local-first) */
  protected async go(event: Event, source: DeviceSource): Promise<void> {
    if (!this.local) return;
    event.preventDefault();
    if (this.busy()) return;
    this.errors.set([]);
    this.busy.set(true);
    try {
      location.assign(await this.device.connectUrl(source));
    } catch (e) {
      this.errors.set(errorList(e));
      this.busy.set(false);
    }
  }

  /** Cet appareil reprend la synchro des sources (le précédent arrête de renouveler les jetons) */
  protected async takeOver(): Promise<void> {
    if (!this.account.unlocked()) return this.errors.set(['Déverrouille d’abord ta sauvegarde (Compte et sauvegarde)']);
    this.errors.set([]);
    this.busy.set(true);
    try {
      await this.device.claim();
    } catch (e) {
      this.errors.set(errorList(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected editClient(): void {
    this.clientId.reset();
    this.clientSecret.reset();
    this.editingClient.set(true);
  }

  protected async saveClient(): Promise<void> {
    const id = this.clientId.value.trim();
    const secret = this.clientSecret.value.trim();
    if (!id || !secret) return this.errors.set(['Colle le Client ID et le Client Secret de ton appli Strava']);
    this.errors.set([]);
    try {
      await this.entries.saveStravaClient(id, secret);
      await this.sync.refresh();
      this.clientSecret.reset();
      this.editingClient.set(false);
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }

  protected async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.errors.set([]);
    this.uploadNotice.set(null);
    try {
      await this.entries.uploadStravaArchive(file);
      this.uploadNotice.set(this.local ? 'Archive importée sur cet appareil.' : 'Archive reçue : import et reconstruction en cours sur le NAS (quelques minutes).');
    } catch (e) {
      this.errors.set(errorList(e));
    }
  }
}
