// File des runs (run.mjs) de tous les comptes : un seul à la fois sur le NAS (mémoire bornée : chaque build charge
// toutes les données d'un compte), dans l'ordre d'arrivée, et au plus une tâche de chaque sorte en attente par compte.
// Sortes : full (synchro complète, reconstruction comprise), rebuild (--rebuild), fit (--fit <id>), archive (--import-strava <zip>).
const KEEP_LINES = 80;
const MAX_ARCHIVES = 2;

export const jobs = {
  full: (trigger) => ({ kind: 'full', trigger, args: [] }),
  rebuild: (trigger = 'saisie') => ({ kind: 'rebuild', trigger, args: ['--rebuild'] }),
  fit: (id) => ({ kind: 'fit', trigger: `tracé ${id}`, args: ['--fit', id] }),
  archive: (file) => ({ kind: 'archive', trigger: 'archive Strava', args: ['--import-strava', file] }),
};

export class RunQueue {
  /**
   * `start(userId, job, onLine)` lance le run et renvoie une promesse du code de sortie ;
   * `onDone(userId, job, code)` est appelé à la fin de chaque run.
   */
  constructor({ start, onDone = () => {}, now = Date.now }) {
    this.start = start;
    this.onDone = onDone;
    this.now = now;
    this.users = new Map();
    this.order = [];
    this.current = null;
  }

  #user(id) {
    if (!this.users.has(id)) this.users.set(id, { startedAt: null, finishedAt: 0, fullAt: 0, log: [], pending: [] });
    return this.users.get(id);
  }

  /** 'started' | 'queued' | 'duplicate' (déjà prévu) | 'busy' (un autre tracé attend déjà, ou trop d'archives) */
  enqueue(userId, job) {
    const u = this.#user(userId);
    const same = (k) => u.pending.filter((p) => p.kind === k);
    if (job.kind === 'full') {
      if (same('full').length) return 'duplicate';
      // La synchro complète reconstruit aussi : elle remplace une reconstruction en attente
      for (const r of same('rebuild')) this.#drop(userId, r);
    } else if (job.kind === 'rebuild') {
      if (same('full').length || same('rebuild').length) return 'duplicate';
    } else if (job.kind === 'fit') {
      const fit = same('fit')[0];
      if (fit) return fit.args[1] === job.args[1] ? 'duplicate' : 'busy';
    } else if (job.kind === 'archive' && same('archive').length >= MAX_ARCHIVES) return 'busy';
    u.pending.push(job);
    this.order.push({ userId, job });
    this.#pump();
    return this.current?.userId === userId && this.current.job === job ? 'started' : 'queued';
  }

  #drop(userId, job) {
    const u = this.#user(userId);
    u.pending = u.pending.filter((p) => p !== job);
    this.order = this.order.filter((o) => o.job !== job);
  }

  #pump() {
    if (this.current || !this.order.length) return;
    const next = this.order.shift();
    const u = this.#user(next.userId);
    u.pending = u.pending.filter((p) => p !== next.job);
    this.current = next;
    u.startedAt = new Date(this.now()).toISOString();
    u.log = [];
    const onLine = (line) => {
      u.log.push(line);
      if (u.log.length > KEEP_LINES) u.log = u.log.slice(-KEEP_LINES);
    };
    Promise.resolve()
      .then(() => this.start(next.userId, next.job, onLine))
      .catch((e) => (onLine(`lancement impossible : ${e.message}`), 1))
      .then((code) => {
        if (code) onLine(`run.mjs terminé avec le code ${code}`);
        u.finishedAt = this.now();
        if (next.job.kind === 'full') u.fullAt = u.finishedAt;
        this.current = null;
        try {
          this.onDone(next.userId, next.job, code);
        } finally {
          this.#pump();
        }
      });
  }

  /** État d'un compte pour GET /api/sync */
  status(userId) {
    const u = this.#user(userId);
    const running = this.current?.userId === userId;
    return { running, queued: u.pending.length > 0, startedAt: u.startedAt, finishedAt: u.finishedAt, fullAt: u.fullAt, log: u.log, kind: running ? this.current.job.kind : null };
  }

  /** Compte supprimé : ses tâches en attente sont abandonnées (le run en cours, s'il y en a un, doit d'abord finir) */
  forget(userId) {
    for (const job of [...this.#user(userId).pending]) this.#drop(userId, job);
    this.users.delete(userId);
  }

  /** Vrai si le compte a un run en cours ou en attente */
  busy(userId) {
    const s = this.status(userId);
    return s.running || s.queued;
  }

  /** Attend que la file soit vide (tests) */
  async idle() {
    while (this.current || this.order.length) await new Promise((r) => setTimeout(r, 5));
  }
}
