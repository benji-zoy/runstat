// Construit public/data/coros.json et routes.json à partir des données brutes de data-raw/ (sources choisies dans
// data-raw/sources.json), et data-raw/missing-details.txt pour COROS. Calcul : src/engine/snapshot/build.ts.
// Usage : node scripts/build-data.mjs
import { buildSnapshot, snapshotSummary, writeSnapshot } from '#engine/snapshot/build.ts';
import { nodeStorage } from './node-storage.mjs';

const storage = nodeStorage();
const result = await buildSnapshot(storage.raw);
for (const w of result.warnings) console.warn(w);
await writeSnapshot(storage, result);
console.log(snapshotSummary(result));
