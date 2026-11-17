/// <reference lib="webworker" />
// Moteur en arrière-plan (mode local-first) : reconstruction complète et import de l'archive Strava dans IndexedDB, sans
// figer l'interface. Messages : { id, type: 'rebuild' } | { id, type: 'import' | 'import-export', file }. Réponses : { id, progress } en cours,
// puis { id, ok: true, result } ou { id, ok: false, error }.
import { blobSource } from '../../engine/archive/zip';
import { importStravaArchive } from '../../engine/archive/strava-archive';
import { importRunstatExport } from '../../engine/archive/export-import';
import { rebuild } from '../../engine/pipeline/rebuild';
import { indexedDbStorage } from '../../engine/storage/indexeddb';

const storage = indexedDbStorage();

addEventListener('message', async ({ data }: MessageEvent<{ id: number; type: 'rebuild' | 'import' | 'import-export'; file?: File }>) => {
  const { id, type } = data;
  try {
    const s = await storage;
    const onProgress = (done: number, total: number) => postMessage({ id, progress: total ? done / total : 0 });
    if (type === 'import-export') {
      const imported = await importRunstatExport(blobSource(data.file!), s.raw, { onProgress });
      const built = await rebuild(s);
      postMessage({ id, ok: true, result: { imported, summary: built.summary } });
    } else if (type === 'import') {
      const imported = await importStravaArchive(blobSource(data.file!), s.raw, { onProgress });
      const built = await rebuild(s);
      postMessage({ id, ok: true, result: { imported, summary: built.summary } });
    } else {
      const built = await rebuild(s);
      postMessage({ id, ok: true, result: { summary: built.summary, state: built.state } });
    }
  } catch (e) {
    postMessage({ id, ok: false, error: (e as Error).message });
  }
});
