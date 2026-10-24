import { Injectable, computed, signal } from '@angular/core';
import { EntryError } from './entries.service';

/** Compte de la requête (GET /api/me, scripts/sync/app.mjs) */
export interface Me {
  id: string;
  name: string;
  role: 'owner' | 'member';
  mode: 'hosted' | 'local';
  /** Instance à plusieurs comptes (users.json sur le NAS) */
  multi: boolean;
  /** Gestion des comptes : propriétaire, par l'adresse Tailscale */
  admin: boolean;
}

/** Compte de l'instance (users.json) : gestion par le propriétaire */
export interface Account {
  id: string;
  name: string;
  role: 'owner' | 'member';
  mode: 'hosted' | 'local';
  logins: string[];
}

/**
 * Compte de la personne connectée au NAS et, pour le propriétaire, la liste des comptes (panneau « Proches »).
 * Sans service de synchro (ng serve, appli publique), `me` reste nul.
 */
@Injectable({ providedIn: 'root' })
export class MeService {
  readonly me = signal<Me | null>(null);
  readonly multi = computed(() => this.me()?.multi ?? false);
  readonly admin = computed(() => this.me()?.admin ?? false);

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('api/me', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      const type = res.headers.get('content-type') ?? '';
      this.me.set(res.ok && type.includes('json') ? await res.json() : null);
    } catch {
      this.me.set(null);
    }
  }

  async accounts(): Promise<Account[]> {
    const res = await fetch('api/admin/users', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new EntryError([json.error ?? `HTTP ${res.status}`]);
    return json;
  }

  async saveAccounts(list: Account[]): Promise<Account[]> {
    let res: Response;
    try {
      res = await fetch('api/admin/users', {
        method: 'PUT',
        headers: { 'X-RunStat': 'sync', 'Content-Type': 'application/json' },
        body: JSON.stringify(list),
      });
    } catch {
      throw new EntryError(['Service de synchro injoignable']);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new EntryError(json.errors ?? [json.error ?? `HTTP ${res.status}`]);
    return json;
  }
}
