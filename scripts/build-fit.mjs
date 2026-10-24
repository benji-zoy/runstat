// Analyse les fichiers FIT (data-raw/fit/*.fit) et les tracés sans FIT (data-raw/tracks/) et met en cache un résumé
// par sortie dans data-raw/fit-derived/<id>.json. Calcul : src/engine/pipeline/build-fit.ts et src/engine/fit/analyse.ts.
// Usage : node scripts/build-fit.mjs [--force]
import { buildFit, buildFitSummary } from '#engine/pipeline/build-fit.ts';
import { nodeStorage } from './node-storage.mjs';

const r = await buildFit(nodeStorage().raw, { force: process.argv.includes('--force') });
for (const w of r.warnings) console.warn(w);
console.log(buildFitSummary(r));
