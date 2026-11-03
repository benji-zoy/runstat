import { adviseSources, SourceAnswers } from './sources-advice';

const ask = (over: Partial<SourceAnswers>): SourceAnswers => ({ watch: 'coros', strava: 'none', google: false, local: false, ...over });

describe('conseil de sources', () => {
  it('COROS : toujours COROS, que Strava soit gratuit ou payant', () => {
    for (const strava of ['none', 'free', 'paid'] as const) {
      const r = adviseSources(ask({ watch: 'coros', strava }));
      expect([r.activities, r.health]).toEqual(['coros', 'coros']);
    }
    expect(adviseSources(ask({ watch: 'coros', strava: 'free' })).notes.join(' ')).toContain('Strava n’ajouterait rien');
  });

  it('COROS + Google Health : la santé vient de Google', () => {
    expect(adviseSources(ask({ watch: 'coros', google: true })).health).toBe('google');
  });

  it('Garmin : Garmin direct même avec Strava payant, qui n’est qu’une alternative signalée', () => {
    const free = adviseSources(ask({ watch: 'garmin', strava: 'free' }));
    expect([free.activities, free.health]).toEqual(['garmin', 'garmin']);
    const paid = adviseSources(ask({ watch: 'garmin', strava: 'paid' }));
    expect(paid.activities).toBe('garmin');
    expect(paid.notes.join(' ')).toContain('plusieurs appareils');
  });

  it('autre montre : API avec Strava payant, archive avec Strava gratuit', () => {
    const paid = adviseSources(ask({ watch: 'other', strava: 'paid' }));
    expect(paid.activities).toBe('strava');
    expect(paid.steps.join(' ')).toContain('strava.com/settings/api');
    const free = adviseSources(ask({ watch: 'other', strava: 'free', google: true }));
    expect([free.activities, free.health]).toEqual(['strava', 'google']);
    expect(free.steps.join(' ')).toContain('archive');
    expect(adviseSources(ask({ watch: 'other', strava: 'free' })).health).toBe('none');
  });

  it('appli publique : prévient que Garmin et Google demandent un compte', () => {
    expect(adviseSources(ask({ watch: 'garmin', local: true })).notes.join(' ')).toContain('compte');
    expect(adviseSources(ask({ watch: 'coros', google: true, local: true })).notes.join(' ')).toContain('compte');
    expect(adviseSources(ask({ watch: 'coros', local: true })).notes.join(' ')).not.toContain('compte');
  });
});
