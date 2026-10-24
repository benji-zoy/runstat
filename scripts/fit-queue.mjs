// Construit data-raw/fit-queue.txt : les sorties sans fichier FIT, par ordre d'utilité (src/engine/fit-queue.ts).
// Usage : node scripts/fit-queue.mjs
import { fitQueue, fitQueueText } from '#engine/fit-queue.ts';
import { nodeStorage } from './node-storage.mjs';

const { raw, snapshot } = nodeStorage();
const { activities } = JSON.parse(await snapshot.readText('coros.json'));
const have = new Set((await raw.list('fit')).map((f) => f.replace('.fit', '')));
const q = fitQueue(activities, have);
await raw.write('fit-queue.txt', fitQueueText(q));
console.log(`File FIT : ${q.race.length} courses, ${q.long.length} sorties longues, ${q.quality.length} fractionné/tempo, ${q.rest.length} autres`);
