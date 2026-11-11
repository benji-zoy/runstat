import { InvalidEntry, validateGoals, validatePlan } from '../entries.ts';
import { MemoryStore } from '../storage/memory.ts';
import { corosClient, WRITE_TOOLS, READ_TOOLS } from '../sync/coros.ts';
import { fileTokenStore } from '../sync/http.ts';
import { corosCreateArgs, corosDraft, corosSections, corosUpdateArgs, parsePlanLibrary, phaseType, pushPlanToCoros } from './coros-plan.ts';
import { mergePlan, parseDurationText, parsePlanMarkdown, parseSteps, type PlanSession, type TrainingPlan } from './plan.ts';

const AI_ANSWER = `
Voici ton plan. Logique : trois phases…

| Semaine | Jour | Séance |
|---|---|---|
| 1 | mardi | footing |

\`\`\`runstat-plan
date | type | nom | durée | distance | étapes | phase
2026-11-17 | facile | Footing | 45 min | 8 km | 45' Z2 | Foncier
2026-11-18 | repos | Repos | - | - | - | Foncier
2026-11-19 | qualité | Fractionné 6 × 1000 m | 65 min | 11 km | 15' Z1 + 6×(1000 m @ 4:10-4:15/km / 2' Z1) + 10' Z1 | Foncier
2026-11-20 | renfo | Renfo bas du corps | 30 min | - | - | Foncier
2026-11-23 | longue | Sortie longue | 1 h 40 | 18 km | 1h40 @ FC 135-145 | Foncier
| 2026-12-01 | Qualité | **Seuil 3 × 10'** | 1h05 | 12,5 km | 20' Z2 + 3×(10' @ 4:30-4:35 / 2' Z1) + 10' Z1 | Développement |
2026-12-02 | ??? | Mystère | 30 min | - | - | -
une ligne de texte perdue
\`\`\`
`;

const session = (date: string, kind: PlanSession['kind'] = 'easy', extra: Partial<PlanSession> = {}): PlanSession => ({ date, kind, name: `S ${date}`, durationMin: 45, ...extra });

describe('plan importé', () => {
  it('lit le bloc runstat-plan : types, durées, distances, étapes, phases, lignes ignorées', () => {
    const p = parsePlanMarkdown(AI_ANSWER);
    expect(p.fenced).toBe(true);
    expect(p.rest).toBe(1);
    expect(p.sessions.map((s) => s.kind)).toEqual(['easy', 'quality', 'strength', 'long', 'quality']);
    expect(p.sessions[3]).toEqual({ date: '2026-11-23', kind: 'long', name: 'Sortie longue', durationMin: 100, distanceKm: 18, steps: '1h40 @ FC 135-145', phase: 'Foncier' });
    expect(p.sessions[4]).toMatchObject({ name: 'Seuil 3 × 10\'', durationMin: 65, distanceKm: 12.5, phase: 'Développement' });
    expect(p.sessions[2].distanceKm).toBeUndefined();
    // Une ligne sans colonnes est du texte : ignorée sans bruit
    expect(p.ignored).toEqual(['2026-12-02 | ??? | Mystère | 30 min | - | - | -']);
  });

  it('se rabat sur les tableaux Markdown sans bloc dédié', () => {
    const p = parsePlanMarkdown('| date | type | nom | durée |\n|---|---|---|---|\n| 17/11/2026 | facile | Footing | 40\' |\n| 2026-02-30 | facile | Faux | 40 min |');
    expect(p.fenced).toBe(false);
    expect(p.sessions).toEqual([{ date: '2026-11-17', kind: 'easy', name: 'Footing', durationMin: 40 }]);
  });

  it('lit les durées et les étapes', () => {
    expect(parseDurationText('1 h 40')).toBe(6000);
    expect(parseDurationText('1h05')).toBe(3900);
    expect(parseDurationText("42'30")).toBe(2550);
    expect(parseDurationText('1:10:00')).toBe(4200);
    expect(parseDurationText('90 s')).toBe(90);
    expect(parseSteps("15' Z1 + 6×(1000 m @ 4:10-4:15 / 2' Z1) + 10' Z1")).toEqual([
      { step: { target: { type: 'time', sec: 900 }, intensity: { type: 'zone', zone: 1 } } },
      {
        repeat: 6,
        steps: [
          { target: { type: 'distance', m: 1000 }, intensity: { type: 'pace', from: 250, to: 255 } },
          { target: { type: 'time', sec: 120 }, intensity: { type: 'zone', zone: 1 } },
        ],
      },
      { step: { target: { type: 'time', sec: 600 }, intensity: { type: 'zone', zone: 1 } } },
    ]);
    expect(parseSteps('3 km @ FC 150-160')).toEqual([{ step: { target: { type: 'distance', m: 3000 }, intensity: { type: 'hr', from: 150, to: 160 } } }]);
    expect(parseSteps('courir tranquille')).toBeNull();
    expect(parseSteps("6×(1000 m @ vite / 2')")).toBeNull();
  });

  it('remplace seulement les jours couverts par le nouveau plan et garde l’état COROS', () => {
    const old: TrainingPlan = {
      goalId: 'g', importedAt: '2026-11-01T10:00:00.000Z', coros: { sentAt: '2026-11-02T10:00:00.000Z', weeks: 4 },
      sessions: [session('2026-11-10'), session('2026-11-20'), session('2026-12-20')],
    };
    const m = mergePlan(old, 'g', [session('2026-11-15', 'quality'), session('2026-11-30')], new Date('2026-11-12T08:00:00Z'));
    expect(m.sessions.map((s) => s.date)).toEqual(['2026-11-10', '2026-11-15', '2026-11-30', '2026-12-20']);
    expect(m.coros?.weeks).toBe(4);
    expect(m.importedAt).toBe('2026-11-12T08:00:00.000Z');
  });

  it('valide le plan et les objectifs secondaires', () => {
    const plan = validatePlan('g', { importedAt: '2026-11-12T08:00:00.000Z', sessions: [session('2026-11-20'), session('2026-11-15')] });
    expect(plan.sessions.map((s) => s.date)).toEqual(['2026-11-15', '2026-11-20']);
    expect(() => validatePlan('g', { importedAt: '2026-11-12T08:00:00.000Z', sessions: [{ ...session('2026-11-20'), kind: 'sieste' }] })).toThrow(InvalidEntry);
    expect(() => validatePlan('G!', { importedAt: '2026-11-12T08:00:00.000Z', sessions: [] })).toThrow(InvalidEntry);
    expect(() => validatePlan('g', { importedAt: '2026-11-12T08:00:00.000Z', sessions: [], secret: 1 })).toThrow(InvalidEntry);
    const main = { id: 'main', name: 'Marathon', date: '2026-04-12', distanceKm: 42.195, kind: 'road' };
    expect(validateGoals([main, { id: 'semi', name: 'Semi', date: '2026-03-08', distanceKm: 21.1, kind: 'road', parent: 'main' }])[1].parent).toBe('main');
    expect(() => validateGoals([main, { id: 'apres', name: 'Après', date: '2026-05-01', distanceKm: 10, kind: 'road', parent: 'main' }])).toThrow(/avant l’objectif principal/);
    expect(() => validateGoals([{ id: 'x', name: 'X', date: '2026-03-01', distanceKm: 10, kind: 'road', parent: 'nulle-part' }])).toThrow(/introuvable/);
  });
});

describe('plan vers COROS', () => {
  const plan: TrainingPlan = {
    goalId: 'g',
    importedAt: '2026-11-11T08:00:00.000Z',
    sessions: [
      session('2026-11-10'),
      session('2026-11-13', 'easy', { phase: 'Foncier', steps: "45' Z2" }),
      session('2026-11-14', 'strength'),
      session('2026-11-19', 'quality', { phase: 'Foncier', steps: "15' Z1 + 6×(1000 m @ 4:10-4:15 / 2' Z1) + 10' Z1" }),
      session('2026-11-26', 'quality', { phase: 'Développement' }),
      session('2026-12-03', 'long', { phase: 'Développement', durationMin: undefined, distanceKm: 18 }),
      session('2026-12-08', 'race', { phase: 'Affûtage', name: 'Semi', durationMin: undefined, distanceKm: 21.1 }),
    ],
  };

  it('classe les phases', () => {
    expect([phaseType('Foncier'), phaseType('Développement'), phaseType('Spécifique'), phaseType('Affûtage'), phaseType('Récupération'), phaseType('Reprise')]).toEqual([2, 3, 4, 5, 6, 1]);
  });

  it('construit des séances structurées', () => {
    expect(corosSections(plan.sessions[3])).toEqual([
      { sectionType: 1, targetType: 2, targetValue: 900, intensityType: 1, sectionIntensity: 1 },
      {
        intervalGroup: true,
        repeats: 6,
        sets: [
          { sectionType: 2, targetType: 1, targetValue: 1000, intensityType: 2, intensityValueStart: 250, intensityValueEnd: 255 },
          { sectionType: 3, targetType: 2, targetValue: 120, intensityType: 1, sectionIntensity: 1 },
        ],
      },
      { sectionType: 4, targetType: 2, targetValue: 600, intensityType: 1, sectionIntensity: 1 },
    ]);
    // Sans étapes lisibles : une section sur la durée ou la distance, zone selon la nature
    expect(corosSections(plan.sessions[4])).toEqual([{ sectionType: 2, targetType: 2, targetValue: 2700, intensityType: 1, sectionIntensity: 3 }]);
    expect(corosSections(plan.sessions[5])).toEqual([{ sectionType: 2, targetType: 1, targetValue: 18000, intensityType: 1, sectionIntensity: 2 }]);
  });

  it('crée un plan en semaines naturelles, sans renfo ni séance passée', () => {
    const draft = corosDraft(plan, '2026-11-11');
    // Du mercredi 11 novembre au dimanche de la semaine de la course du 8 décembre
    expect(draft).toMatchObject({ start: '2026-11-11', weeks: 5, end: '2026-12-13', later: 0 });
    expect(draft.sessions.map((s) => s.date)).toEqual(['2026-11-13', '2026-11-19', '2026-11-26', '2026-12-03', '2026-12-08']);
    const args = corosCreateArgs(plan, 'Marathon test', draft);
    expect(args.planInfo).toMatchObject({ planName: 'RunStat · Marathon test', planStartDate: 20261111, totalWeeks: 5 });
    expect(args.courseList.map((c: any) => c.dayNo)).toEqual([2, 8, 15, 22, 27]);
    expect(args.phaseInfo.periodization).toEqual([
      { phaseType: 2, startDate: 20261111, endDate: 20261122, durationWeeks: 2 },
      { phaseType: 3, startDate: 20261123, endDate: 20261206, durationWeeks: 2 },
      { phaseType: 5, startDate: 20261207, endDate: 20261213, durationWeeks: 1 },
    ]);
  });

  it('refuse un plan qui commence trop tard ou trop court', () => {
    expect(() => corosDraft(plan, '2026-10-20')).toThrow(/14 jours/);
    expect(() => corosDraft({ ...plan, sessions: [session('2026-11-13')] }, '2026-11-11')).toThrow(/4 semaines/);
    expect(() => corosDraft({ ...plan, sessions: [session('2026-11-13', 'strength')] }, '2026-11-11')).toThrow(/aucune séance/);
  });

  it('coupe à 16 semaines', () => {
    const long = { ...plan, sessions: Array.from({ length: 20 }, (_, w) => session(new Date(Date.UTC(2026, 10, 12 + 7 * w)).toISOString().slice(0, 10))) };
    const d = corosDraft(long, '2026-11-11');
    expect(d.weeks).toBe(16);
    expect(d.later).toBe(4);
  });

  it('réécrit le plan en cours jour par jour, repos compris', () => {
    const draft = corosDraft(plan, '2026-11-12', '2026-11-09');
    const args = corosUpdateArgs(plan, '42', '2026-11-09', draft, '2026-11-12');
    expect(args.planInfo).toEqual({ planId: '42', totalWeeks: 5 });
    const days = args.courseList as any[];
    expect(days[0]).toMatchObject({ dayNo: 3, sportType: 4, sections: [] });
    expect(days.find((c) => c.dayNo === 4)).toMatchObject({ sportType: 1, courseName: 'S 2026-11-13' });
    expect(days.find((c) => c.dayNo === 29)).toMatchObject({ sportType: 1, courseName: 'Semi' });
    expect(days.at(-1).dayNo).toBe(34);
  });

  it('lit la bibliothèque des plans COROS', () => {
    const rows = parsePlanLibrary(`Training Plan Library
========================
Plans on this page: 2

1. RunStat · Marathon test [In progress] [mcp]
   Plan ID: 4683
   Record role: execution
   Editable via MCP: yes
   Dates: 2026-11-09 to 2026-12-06
   Weeks: 4

2. 10k Intermediate [Not started] [custom]
   Plan ID: 4658
   Record role: library
   Editable via MCP: no
   Weeks: 10
`);
    expect(rows).toEqual([
      { name: 'RunStat · Marathon test', status: 'in progress', planId: '4683', role: 'execution', editable: true, start: '2026-11-09' },
      { name: '10k Intermediate', status: 'not started', planId: '4658', role: 'library', editable: false },
    ]);
  });

  it('crée, puis met à jour le plan RunStat en cours', async () => {
    const calls: [string, any][] = [];
    let library = 'Plans on this page: 0';
    const client = {
      toolText: (r: any) => r.text,
      callTool: async (name: string, args: any) => (calls.push([name, args]), { text: library }),
      callWriteTool: async (name: string, args: any) => (calls.push([name, args]), { text: 'ok' }),
    };
    const first = await pushPlanToCoros(client, plan, 'Marathon test', '2026-11-11', new Date('2026-11-11T09:00:00Z'));
    expect(first).toEqual({ sentAt: '2026-11-11T09:00:00.000Z', start: '2026-11-11', weeks: 5, sessions: 5 });
    expect(calls.map((c) => c[0])).toEqual(['queryTrainingPlanLibrary', 'createTrainingPlan']);
    library = '1. RunStat · Marathon test [In progress] [mcp]\n   Plan ID: 77\n   Record role: execution\n   Editable via MCP: yes\n   Dates: 2026-11-11 to 2026-12-06\n';
    calls.length = 0;
    await pushPlanToCoros(client, plan, 'Marathon test', '2026-11-12');
    expect(calls[1][0]).toBe('updateTrainingPlan');
    expect(calls[1][1].planInfo.planId).toBe('77');
    // Refus de COROS : message remonté
    const refused = { ...client, callWriteTool: async () => ({ isError: true, text: 'planStartDate out of range' }) };
    library = 'Plans on this page: 0';
    await expect(pushPlanToCoros(refused, plan, 'Marathon test', '2026-11-11')).rejects.toThrow(/out of range/);
  });

  it('n’écrit chez COROS que les outils de plan, et jamais par callTool', async () => {
    expect([...WRITE_TOOLS]).toEqual(['createTrainingPlan', 'updateTrainingPlan']);
    for (const name of READ_TOOLS) expect(name).toMatch(/^(query|get)/);
    let called = 0;
    const fetch = (async () => (called++, new Response('{}'))) as any;
    const c = corosClient({ tokens: fileTokenStore(new MemoryStore()), fetch });
    await expect(c.callTool('createTrainingPlan', {})).rejects.toThrow(/non autorisé/);
    await expect(c.callWriteTool('createScheduledWorkout', {})).rejects.toThrow(/non autorisé/);
    expect(called).toBe(0);
  });
});
