import snapshot from '../../../../scripts/sync/fixtures/engine/expected/coros.json';
import { CorosData, Goal } from '../models';
import { classifyAll } from '../science';
import { evaluateGoal, goalContext, goalResult } from '../goals';
import { raceDebrief } from '../debrief';
import { runnerMatrix } from '../matrix';
import { conditionsCost, personalCoefficients } from '../conditions';
import { CAPABILITIES } from '../sources';
import { parseDay } from '../stats';
import { AiInput, AiOptions, age, trainingPaces } from './context';
import { PlanRequest, cycleExport, debriefExport, goalExport, planExport, profileExport, runExport, scrubNames } from './exports';
import { parsePlanMarkdown, parseSteps } from '../../../engine/plan/plan';

const data = snapshot as unknown as CorosData;
const today = parseDay('2026-03-11');
const athlete = { ...data.athlete!, birthday: '1990-06-15', heightCm: 178 };
const acts = data.activities;
const types = classifyAll(acts, athlete);
const input: AiInput = { acts, types, athlete, health: data.health, fitness: data.fitness, caps: CAPABILITIES.coros, today };
const summary: AiOptions = { detail: 'summary', health: true };
const full: AiOptions = { detail: 'full', health: true };

const evaluate = (g: Goal) =>
  evaluateGoal(g, goalContext(g, acts, types, athlete, today, data.fitness?.predictions ?? {}, data.health), today, acts)!;

/** Aucune donnée qui situe ou nomme la personne : coordonnées, noms libres des sorties */
function expectPrivate(md: string): void {
  for (const a of acts) {
    if (a.lat !== null) expect(md).not.toContain(String(a.lat));
    if (a.lon !== null) expect(md).not.toContain(String(a.lon));
  }
  expect(md).not.toContain('Parc imaginaire');
  expect(md).not.toContain('Boucle de la colline');
}

describe('export pour une IA', () => {
  it('décrit une sortie avec glossaire, déroulé et consigne', () => {
    const a = acts.find((x) => x.id === '100003')!;
    const doc = runExport(a, input, summary, conditionsCost(a, athlete, personalCoefficients(acts, types)));
    const md = doc.markdown;
    expect(md.startsWith('# Analyse d\'une sortie')).toBe(true);
    expect(md).toContain('## Glossaire');
    expect(md).toContain('**Découplage Pa:HR**');
    expect(md).toContain('kilomètre par kilomètre');
    expect(md).toContain('## Entraînement avant cette sortie');
    // Le glossaire précède le contenu, la consigne le termine
    expect(md.indexOf('## Glossaire')).toBeLessThan(md.indexOf('## La sortie'));
    expect(md.lastIndexOf('## Ce que j\'attends de toi')).toBeGreaterThan(md.indexOf('## Santé et récupération'));
    // N'explique que les notions employées
    expect(md).not.toContain('**Runner Matrix**');
    expect(doc.filename).toBe('runstat-sortie-2026-03-01-2026-03-11.md');
    expect(doc.tokens).toBeGreaterThan(100);
    expectPrivate(md);
  });

  it('ajoute la question, facultative, à la fin', () => {
    const a = acts.find((x) => x.id === '100001')!;
    const without = runExport(a, input, summary, null).markdown;
    expect(without).not.toContain('### Ma question');
    const md = runExport(a, input, { ...summary, question: 'Pourquoi ma FC était-elle si haute ?' }, null).markdown;
    expect(md.trimEnd().endsWith('Pourquoi ma FC était-elle si haute ?')).toBe(true);
  });

  it('retire la santé quand elle n\'est pas partagée', () => {
    const a = acts.find((x) => x.id === '100004')!;
    const withHealth = runExport(a, input, full, null).markdown;
    expect(withHealth).toContain('## Santé et récupération');
    expect(withHealth).toContain('Poids : 70 kg');
    const md = runExport(a, input, { ...full, health: false }, null).markdown;
    expect(md).not.toContain('## Santé et récupération');
    expect(md).not.toContain('VFC');
    expect(md).not.toContain('Poids');
    expect(md).toContain('données de santé non partagées');
  });

  it('est plus court en résumé qu\'en complet', () => {
    const a = acts.find((x) => x.id === '100003')!;
    expect(runExport(a, input, summary, null).tokens).toBeLessThan(runExport(a, input, full, null).tokens);
  });

  it('présente un objectif avec l\'évaluation, les modèles et la stratégie', () => {
    const e = evaluate(data.goals!.find((g) => g.id === 'marathon-test')!);
    const md = goalExport(e, input, full).markdown;
    expect(md).toContain('# Objectif : Marathon de Testville (2026-04-12)');
    expect(md).toContain('Chrono le plus probable');
    expect(md).toContain('### Modèles');
    expect(md).toContain('## Stratégie de course proposée par RunStat');
    expect(md).toContain('Chrono visé : 3:30:00');
    expect(md).toContain('**Prédiction et probabilité**');
    expectPrivate(md);
  });

  it('objectif sans la santé : ni ajustement ni conseil « Récupération », ni grammes déduits du poids', () => {
    const base = evaluate(data.goals!.find((g) => g.id === 'marathon-test')!);
    const sleep = 'Le sommeil des derniers jours est court : priorité aux nuits de 7 h et plus d\'ici la course.';
    const e = {
      ...base,
      adjustments: [...base.adjustments, { label: 'Récupération', pct: 1.5, note: 'VFC sous ta base' }],
      readiness: [...base.readiness, { label: 'Récupération', value: 'VFC basse, 6 h 10', target: 'base, 7 h', score: 0.4, projected: 0.4, weight: 10, advice: sleep }],
      advice: [...base.advice, sleep],
      plan: { ...base.plan, blocks: [...base.plan.blocks.filter((b) => b.title !== 'Les derniers jours'), { icon: '🍝', title: 'Les derniers jours', items: ['Recharge : soit 490 à 700 g par jour.'], withoutWeight: ['Recharge : 7 à 10 g par kg et par jour.'] }] },
    } as typeof base;
    const shared = goalExport(e, input, full).markdown;
    expect(shared).toContain(sleep);
    expect(shared).toContain('490 à 700 g');
    const md = goalExport(e, input, { ...full, health: false }).markdown;
    expect(md).not.toContain(sleep);
    expect(md).not.toContain('Récupération');
    expect(md).not.toContain('+1,5 %');
    expect(md).not.toContain('490');
    expect(md).toContain('7 à 10 g par kg et par jour');
  });

  it('prépare un plan avec les choix de l\'assistant et le format de retour', () => {
    const e = evaluate(data.goals!.find((g) => g.id === 'trail-test')!);
    const prep = evaluate({ id: 'prep', name: '10 km de Testville', date: '2026-04-05', distanceKm: 10, targetSec: 2400, kind: 'road' });
    const request: PlanRequest = {
      volume: { min: 40, max: 60 },
      sessions: { min: 3, max: 4 },
      days: [1, 3, 5, 6],
      longDays: [5, 6],
      mode: 'ambitious',
      strength: [{ day: 0, focus: 'lower' }],
      vision: 'club le mardi',
      injuries: 'tendon d\'Achille\nsensible',
      secondaries: [prep],
      checks: [{ level: 'warning', text: 'Trop proche' }],
    };
    const md = planExport(e, input, summary, request).markdown;
    expect(md).toContain('## Mes choix pour le plan');
    expect(md).toContain('Volume au plus fort du plan : 40 à 60 km/semaine');
    expect(md).toContain('Séances de course par semaine : 3 ou 4 selon la semaine et la phase');
    expect(md).toContain('Jours où je peux courir : mardi, jeudi, samedi, dimanche');
    expect(md).toContain('Jours possibles pour la sortie longue : samedi, dimanche');
    expect(md).toContain('Renforcement : lundi (bas du corps)');
    expect(md).toContain('Mode ambitieux');
    // Un retour à la ligne saisi ne casse pas la liste
    expect(md).toContain('Gênes, blessures actuelles ou récentes : tendon d\'Achille sensible');
    expect(md).toContain('## Objectifs secondaires à intégrer au plan');
    expect(md).toContain('10 km de Testville');
    expect(md).toContain('⚠️ Trop proche');
    expect(md).toContain('Propose-moi un plan d\'entraînement de 10 semaines');
    // Le format demandé à l'IA est celui que relit l'import
    expect(md).toContain('```runstat-plan');
    const parsed = parsePlanMarkdown(md);
    expect(parsed.fenced).toBe(true);
    expect(parsed.sessions.map((s) => s.kind)).toEqual(['easy', 'quality', 'strength', 'long']);
    expect(parsed.ignored).toEqual([]);
    for (const s of parsed.sessions.filter((x) => x.steps)) expect(parseSteps(s.steps!)).not.toBeNull();
    expectPrivate(md);
  });

  it('prépare un cycle sans course avec son but, son test et le bilan du précédent', () => {
    const md = cycleExport(input, summary, {
      volume: { min: 20, max: 40 },
      sessions: { min: 3, max: 3 },
      days: [],
      longDays: [6],
      mode: 'normal',
      strength: null,
      cycle: { name: 'Cycle Vitesse · mars 2026', focusLabel: 'Vitesse', focusPrompt: 'But : gagner en vitesse.', start: '2026-03-16', weeks: 6 },
      test: { km: 5, date: '2026-04-26', predicted: 1260 },
      previous: { name: 'Cycle Endurance', focus: 'Endurance', start: '2026-01-05', end: '2026-03-01', done: 30, planned: 34, doneKm: 250, plannedKm: 280, test: null, ef: { before: 1.2, now: 1.3 }, vdot: { before: 45, now: 46.5 } },
    }).markdown;
    expect(md).toContain('# Cycle d\'entraînement : vitesse (2026-03-16)');
    expect(md).toContain('Dates : du 2026-03-16 au 2026-04-26 (6 semaines)');
    expect(md).toContain('Test de fin de cycle : 5 km chronométré le 2026-04-26 (chrono probable aujourd\'hui : 21:00)');
    expect(md).toContain('Séances faites : 30 sur 34 prévues');
    expect(md).toContain('VDOT : 45 → 46,5');
    expect(md).toContain('But : gagner en vitesse.');
    expect(parsePlanMarkdown(md).sessions).toHaveLength(4);
    expectPrivate(md);
  });

  it('fait le bilan d\'une course passée', () => {
    // Après le semi du 22 février, qui sert de référence aux modèles
    const semi: Goal = { id: 'quinze', name: '14 km de Testville', date: '2026-03-05', distanceKm: 14, targetSec: 4700, kind: 'road', debrief: { gelsKm: [10], notes: ['Jambes lourdes'] } };
    const e = evaluate(semi);
    const result = goalResult(semi, acts)!;
    const d = raceDebrief(e, result, athlete, acts, null);
    const md = debriefExport(e, d, input, full, null).markdown;
    expect(md).toContain('# Bilan de course : 14 km de Testville (2026-03-05)');
    expect(md).toContain('Face à la prédiction de la veille');
    expect(md).toContain('- Jambes lourdes');
    expect(md).toContain('## Entraînement avant la course');
  });

  it('dresse le profil du coureur', () => {
    const matrix = runnerMatrix({ acts, athlete, types, health: data.health, today, corosVo2max: data.fitness?.vo2max ?? null });
    const goals = data.goals!.map(evaluate);
    const md = profileExport(input, full, matrix, goals).markdown;
    expect(md).toContain('# Profil du coureur');
    expect(md).toContain('## Profil Runner Matrix');
    expect(md).toContain('## Habitudes');
    expect(md).toContain('Âge : 35 ans');
    expect(md).toContain('Marathon de Testville');
    const noHealth = profileExport(input, { ...full, health: false }, matrix, goals).markdown;
    expect(md).toContain('| Physiologie | VFC nocturne |');
    expect(noHealth).not.toContain('| Physiologie | VFC nocturne |');
    expect(noHealth).not.toContain('| Physiologie | FC de repos |');
    expectPrivate(md);
  });
});

describe('outils des exports', () => {
  it('remplace le nom libre d\'une sortie, pas celui d\'une course', () => {
    const text = 'VDOT d\'après Boucle de la colline (meilleur effort) ; Semi de Testville 2026 ; Tapis';
    const out = scrubNames(text, input);
    expect(out).toContain('d\'après une sortie (meilleur effort)');
    expect(out).toContain('Semi de Testville 2026');
    expect(out).toContain('Tapis');
  });

  it('retrouve les allures de Daniels (VDOT 50)', () => {
    const p = Object.fromEntries(trainingPaces(50).map((x) => [x.label[0], x.pace]));
    const sec = (s: string) => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
    // Table de Daniels, VDOT 50 : M 4:31, T 4:15, I 3:55 (± 6 s)
    expect(Math.abs(sec(p['M']) - 271)).toBeLessThan(6);
    expect(Math.abs(sec(p['T']) - 255)).toBeLessThan(6);
    expect(Math.abs(sec(p['I']) - 235)).toBeLessThan(6);
  });

  it('calcule l\'âge sans date de naissance valide', () => {
    expect(age('1990-06-15', today)).toBe(35);
    expect(age('1990-03-11', today)).toBe(36);
    expect(age(undefined, today)).toBeNull();
  });
});
