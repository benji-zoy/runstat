import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { AiExportService, AiSubject, KIND_LABELS } from '../../core/ai-export.service';
import { AiDetail } from '../../core/ai/context';
import { AiExportKind } from '../../core/ai/exports';
import { IconComponent } from '../icon';
import { canCopy, canShare, copyDoc, downloadDoc, shareDoc } from './md-delivery';

const HEALTH_KEY = 'runstat-ai-sante';
const DETAIL_KEY = 'runstat-ai-detail';

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* navigation privée : réglage non mémorisé */
  }
}

/**
 * « Discuter avec une IA » : prépare un fichier Markdown (une sortie, un objectif, un plan, un bilan, le profil) à coller
 * ou joindre dans l'assistant de son choix. Rien n'est envoyé par RunStat : copier, télécharger ou partager.
 */
@Component({
  selector: 'app-ai-export-dialog',
  imports: [IconComponent],
  template: `
    <dialog #dlg class="sheet" aria-label="Discuter avec une IA" (close)="closed()">
      <form novalidate (submit)="$event.preventDefault(); copy()">
        <header>
          <h2>Discuter avec une IA</h2>
          <button type="button" class="icon-btn" (click)="close()" aria-label="Fermer"><app-icon name="close" /></button>
        </header>
        <div class="body">
          <p class="intro muted">
            RunStat prépare un texte avec tes chiffres, un glossaire et une consigne. Colle-le ou joins-le dans la conversation de
            l'assistant de ton choix (ChatGPT, Claude, Gemini, Le Chat…). Rien n'est envoyé par RunStat : c'est toi qui le transmets.
          </p>

          @if (kinds().length > 1) {
            <div class="seg" role="group" aria-label="Sujet">
              @for (k of kinds(); track k) {
                <button type="button" [class.active]="kind() === k" [attr.aria-pressed]="kind() === k" (click)="kind.set(k)">{{ labels[k] }}</button>
              }
            </div>
          }

          <label class="field">
            Ta question <span class="hint">(facultatif)</span>
            <textarea rows="3" maxlength="2000" [placeholder]="placeholder()" [value]="question()" (input)="question.set(textOf($event))"></textarea>
            <span class="hint">Sans question, l'IA suit la consigne prévue pour {{ labels[kind()].toLowerCase() }}.</span>
          </label>

          <div class="options">
            <div class="field">
              Niveau de détail
              <div class="seg" role="group" aria-label="Niveau de détail">
                <button type="button" [class.active]="detail() === 'summary'" [attr.aria-pressed]="detail() === 'summary'" (click)="setDetail('summary')">Résumé</button>
                <button type="button" [class.active]="detail() === 'full'" [attr.aria-pressed]="detail() === 'full'" (click)="setDetail('full')">Complet</button>
              </div>
            </div>
            @if (ai.hasHealth()) {
              <label class="check">
                <input type="checkbox" [checked]="health()" (change)="setHealth($any($event.target).checked)" />
                <span>Inclure ma santé <small class="muted">sommeil, VFC, FC de repos, poids</small></span>
              </label>
            }
          </div>

          @if (doc(); as d) {
            <p class="size muted">
              ≈ {{ fmt(d.tokens) }} jetons · {{ kb(d.markdown) }} Ko · aucune coordonnée GPS, aucun nom de sortie ni de tiers
            </p>
            <details class="preview">
              <summary>Aperçu du texte</summary>
              <pre>{{ d.markdown }}</pre>
            </details>
          } @else {
            <p class="muted">Pas assez de données pour préparer cet export.</p>
          }
          @if (status(); as s) {
            <p class="status" role="status">{{ s }}</p>
          }
        </div>
        <footer>
          @if (canShare) {
            <button type="button" class="btn" [disabled]="!doc()" (click)="share()"><app-icon name="share" />Partager</button>
          }
          <button type="button" class="btn" [disabled]="!doc()" (click)="download()"><app-icon name="download" />Télécharger</button>
          <span class="spacer"></span>
          @if (canCopy) {
            <button type="submit" class="btn primary" [disabled]="!doc()"><app-icon name="copy" />{{ copied() ? 'Copié' : 'Copier' }}</button>
          }
        </footer>
      </form>
    </dialog>
  `,
  styles: `
    .intro { margin: 0; font-size: 0.88rem; line-height: 1.45; }
    .options { display: flex; flex-wrap: wrap; align-items: end; gap: 0.9rem 1.5rem; }
    .check { display: flex; align-items: center; gap: 0.55rem; min-height: 44px; font-size: 0.9rem; cursor: pointer; }
    .check input { width: 1.15rem; height: 1.15rem; accent-color: var(--accent-fill); }
    .check small { display: block; font-size: 0.78rem; }
    .size { margin: 0; font-size: 0.8rem; }
    .preview summary { cursor: pointer; font-weight: 600; font-size: 0.88rem; color: var(--accent-text); }
    .preview pre {
      margin: 0.5rem 0 0; max-height: 40vh; overflow: auto; padding: 0.7rem; border-radius: 8px; background: var(--surface-2);
      font: 0.75rem/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .status { margin: 0; font-size: 0.85rem; color: var(--accent-text); }
  `,
})
export class AiExportDialogComponent {
  protected readonly ai = inject(AiExportService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
  protected readonly labels = KIND_LABELS;
  protected readonly canCopy = canCopy();
  protected readonly canShare = canShare();

  private readonly subject = signal<AiSubject | null>(null);
  protected readonly kinds = computed(() => (this.subject() ? this.ai.kinds(this.subject()!) : []));
  protected readonly kind = signal<AiExportKind>('run');
  protected readonly detail = signal<AiDetail>(remembered(DETAIL_KEY) === 'full' ? 'full' : 'summary');
  protected readonly health = signal(remembered(HEALTH_KEY) !== '0');
  protected readonly question = signal('');
  protected readonly copied = signal(false);
  protected readonly status = signal<string | null>(null);

  /** Texte régénéré à chaque réglage (calculs déjà faits pour l'interface : rapide) */
  protected readonly doc = computed(() => {
    const s = this.subject();
    if (!s || !this.kinds().includes(this.kind())) return null;
    return this.ai.build(s, this.kind(), { detail: this.detail(), health: this.health(), question: this.question() });
  });

  protected readonly placeholder = computed(() => ({
    run: 'Ex. pourquoi ma FC a-t-elle autant dérivé après le 10e km ?',
    goal: 'Ex. est-ce que je peux viser 3 h 25 ?',
    plan: 'Ex. je préfère deux séances de qualité par semaine.',
    debrief: 'Ex. qu\'est-ce qui m\'a fait perdre du temps dans la seconde moitié ?',
    profile: 'Ex. suis-je plutôt fait pour le trail ou pour la route ?',
  })[this.kind()]);

  /** Ouvre la fenêtre sur un sujet ; `kind` choisit l'export de départ quand il y en a plusieurs */
  open(subject: AiSubject, kind?: AiExportKind): void {
    this.subject.set(subject);
    const kinds = this.ai.kinds(subject);
    this.kind.set(kind && kinds.includes(kind) ? kind : kinds[0] ?? 'run');
    this.question.set('');
    this.status.set(null);
    this.copied.set(false);
    const d = this.dlg().nativeElement;
    if (!d.open) d.showModal();
    d.querySelector<HTMLElement>('.body')?.scrollTo(0, 0);
  }

  close(): void {
    this.dlg().nativeElement.close();
  }

  protected closed(): void {
    this.subject.set(null);
  }

  protected setDetail(d: AiDetail): void {
    this.detail.set(d);
    remember(DETAIL_KEY, d);
  }

  protected setHealth(on: boolean): void {
    this.health.set(on);
    remember(HEALTH_KEY, on ? '1' : '0');
  }

  protected textOf(e: Event): string {
    return (e.target as HTMLTextAreaElement).value;
  }

  protected fmt = (x: number) => (Math.round(x / 100) * 100).toLocaleString('fr-FR');
  protected kb = (s: string) => Math.max(1, Math.round(new Blob([s]).size / 1024)).toLocaleString('fr-FR');

  protected async copy(): Promise<void> {
    const d = this.doc();
    if (!d || !this.canCopy) return;
    const msg = await copyDoc(d);
    this.status.set(msg);
    if (msg.startsWith('Copié')) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    }
  }

  protected download(): void {
    const d = this.doc();
    if (d) this.status.set(downloadDoc(d));
  }

  protected async share(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    const msg = await shareDoc(d);
    if (msg) this.status.set(msg);
  }
}
