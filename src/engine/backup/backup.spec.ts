// Sauvegarde chiffrée de bout en bout : allers-retours, mauvaise phrase de passe, objets et manifestes altérés ou rejoués,
// changement de phrase de passe, code de secours ; synchro entre deux appareils sur un NAS simulé (mêmes règles que
// scripts/sync/backup-store.mjs : versions contrôlées, 412, objets immuables).
import { MemoryStore } from '../storage/memory.ts';
import {
  TamperedData,
  WrongPassphrase,
  decryptManifest,
  decryptObject,
  encryptManifest,
  encryptObject,
  newDataKey,
  normalizeRecovery,
  recoveryCode,
  unwrapKey,
  workKeys,
  wrapKey,
} from './crypto.ts';
import { Conflict, INDEX_FILE, Rollback, syncBackup, type BackupApi, type BackupHeader, type RemoteManifest } from './sync.ts';

const enc = new TextEncoder();
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

/** NAS simulé : manifestes versionnés (If-Match), objets immuables, possibilité de rejouer un ancien manifeste */
function fakeNas() {
  const manifests: RemoteManifest[] = [];
  const objects = new Map<string, Uint8Array>();
  let served: RemoteManifest | null = null;
  const api: BackupApi & { replay(v: number): void; objects: Map<string, Uint8Array>; manifests: RemoteManifest[]; hooks: { beforePut?: () => Promise<void> } } = {
    objects,
    manifests,
    hooks: {},
    replay: (v) => (served = manifests.find((m) => m.version === v)!),
    getManifest: async () => served ?? manifests.at(-1) ?? null,
    listManifests: async () => manifests.map((m) => ({ version: m.version, createdAt: '' })),
    getManifestVersion: async (v) => manifests.find((m) => m.version === v)!,
    async putManifest(body, expected) {
      await api.hooks.beforePut?.();
      const current = manifests.at(-1)?.version ?? null;
      if (expected !== current) throw new Conflict(current);
      if (body.objects.some((id) => !objects.has(id))) throw new Error('objets absents');
      manifests.push({ version: body.version, header: body.header, blob: body.blob, objects: body.objects });
    },
    missing: async (ids) => ids.filter((id) => !objects.has(id)),
    putObject: async (id, data) => void (objects.has(id) || objects.set(id, data)),
    getObject: async (id) => objects.get(id)!,
  };
  return api;
}

describe('chiffrement', () => {
  it('clé de données enveloppée : bonne phrase de passe, mauvaise refusée, code de secours, changement de phrase', async () => {
    const dataKey = newDataKey();
    const code = recoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    const wraps = [await wrapKey(dataKey, 'cheval agrafe batterie correcte', 'passphrase'), await wrapKey(dataKey, code, 'recovery')];
    expect(wraps[0].iterations).toBe(600_000);
    expect(await unwrapKey(wraps, 'cheval agrafe batterie correcte')).toEqual(dataKey);
    await expect(unwrapKey(wraps, 'cheval agrafe batterie fausse')).rejects.toBeInstanceOf(WrongPassphrase);
    expect(await unwrapKey(wraps, normalizeRecovery(code.toLowerCase().replace(/-/g, ' ')), 'recovery')).toEqual(dataKey);
    // Nouvelle phrase de passe : seule l'enveloppe change, la clé de données reste
    const rewrapped = [await wrapKey(await unwrapKey(wraps, 'cheval agrafe batterie correcte'), 'nouvelle phrase longue', 'passphrase'), wraps[1]];
    expect(await unwrapKey(rewrapped, 'nouvelle phrase longue')).toEqual(dataKey);
    await expect(unwrapKey(rewrapped, 'cheval agrafe batterie correcte')).rejects.toBeInstanceOf(WrongPassphrase);
    // Un en-tête qui baisse les itérations est refusé (le serveur fournit l'en-tête)
    await expect(unwrapKey([{ ...wraps[0], iterations: 1000 }], 'cheval agrafe batterie correcte')).rejects.toBeInstanceOf(TamperedData);
  });

  it('objets et manifestes : aller-retour, altération, échange d’objets, rejeu sous une autre version ou un autre compte', async () => {
    const keys = await workKeys(newDataKey());
    const other = await workKeys(newDataKey());
    const a = await encryptObject(keys, enc.encode('séance du mardi'));
    const b = await encryptObject(keys, enc.encode('autre fichier'));
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect((await encryptObject(keys, enc.encode('séance du mardi'))).id).toBe(a.id);
    expect(text(await decryptObject(keys, a.id, a.data))).toBe('séance du mardi');
    const flipped = a.data.slice();
    flipped[20] ^= 1;
    await expect(decryptObject(keys, a.id, flipped)).rejects.toBeInstanceOf(TamperedData);
    await expect(decryptObject(keys, a.id, b.data)).rejects.toBeInstanceOf(TamperedData);
    await expect(decryptObject(other, a.id, a.data)).rejects.toBeInstanceOf(TamperedData);

    const blob = await encryptManifest(keys, 'carol', 3, { files: {} });
    expect(await decryptManifest(keys, 'carol', 3, blob)).toEqual({ files: {} });
    await expect(decryptManifest(keys, 'carol', 4, blob)).rejects.toBeInstanceOf(TamperedData);
    await expect(decryptManifest(keys, 'dave', 3, blob)).rejects.toBeInstanceOf(TamperedData);
  });
});

describe('synchro entre appareils', () => {
  let header: BackupHeader;
  let keys: Awaited<ReturnType<typeof workKeys>>;
  beforeAll(async () => {
    const dataKey = newDataKey();
    header = { v: 1, wraps: [await wrapKey(dataKey, 'phrase de passe commune', 'passphrase')] };
    keys = await workKeys(dataKey);
  });
  const device = (id: string) => ({ id, name: `Appareil ${id}` });

  it('restauration, modifications croisées, suppression, ce qui se reconstruit n’est pas envoyé', async () => {
    const nas = fakeNas();
    const phone = new MemoryStore({ 'athlete.json': '{"hrMax":190}', 'goals.json': '[]', 'fit/1.fit': new Uint8Array(300_000).fill(7), 'fit-derived/1.json': '{}', 'local-state.json': '{}' });
    const first = await syncBackup({ raw: phone, api: nas, keys, account: 'carol', device: device('tel'), header });
    expect(first).toMatchObject({ version: 1, uploaded: 3, downloaded: 0 });
    // Le gros FIT seul, les petits fichiers regroupés : 2 objets, rien de ce qui se reconstruit
    expect(nas.objects.size).toBe(2);
    expect(nas.manifests[0].objects).toHaveLength(2);
    for (const data of nas.objects.values()) expect(text(data)).not.toContain('hrMax');

    // Nouvel appareil vide : restauration complète
    const laptop = new MemoryStore();
    const restored = await syncBackup({ raw: laptop, api: nas, keys, account: 'carol', device: device('pc') });
    expect(restored).toMatchObject({ version: 1, downloaded: 3, changed: true });
    expect(text(await laptop.read('athlete.json'))).toBe('{"hrMax":190}');
    expect((await laptop.read('fit/1.fit'))!.length).toBe(300_000);
    expect(await laptop.read('fit-derived/1.json')).toBeNull();

    // Modifications des deux côtés, sur des fichiers différents ; suppression d'un côté
    await laptop.write('goals.json', '[{"id":"semi"}]');
    await phone.write('athlete.json', '{"hrMax":192}');
    await phone.remove('fit/1.fit');
    await syncBackup({ raw: laptop, api: nas, keys, account: 'carol', device: device('pc') });
    const r = await syncBackup({ raw: phone, api: nas, keys, account: 'carol', device: device('tel') });
    expect(r).toMatchObject({ downloaded: 1, uploaded: 1 });
    expect(text(await phone.read('goals.json'))).toBe('[{"id":"semi"}]');
    const back = await syncBackup({ raw: laptop, api: nas, keys, account: 'carol', device: device('pc') });
    expect(back).toMatchObject({ downloaded: 1, deleted: 1 });
    expect(text(await laptop.read('athlete.json'))).toBe('{"hrMax":192}');
    expect(await laptop.read('fit/1.fit')).toBeNull();
    // Le fichier supprimé ne revient pas à la synchro suivante (pierre tombale)
    await syncBackup({ raw: phone, api: nas, keys, account: 'carol', device: device('tel') });
    expect(await phone.read('fit/1.fit')).toBeNull();
    // Rien de neuf : pas de nouvelle version
    const versions = nas.manifests.length;
    expect((await syncBackup({ raw: phone, api: nas, keys, account: 'carol', device: device('tel') })).uploaded).toBe(0);
    expect(nas.manifests.length).toBe(versions);
    expect(JSON.parse(text(await phone.read(INDEX_FILE))!).maxVersion).toBe(versions);
  });

  it('écriture concurrente (412) : on relit, on fusionne, on renvoie', async () => {
    const nas = fakeNas();
    const a = new MemoryStore({ 'goals.json': '[]' });
    const b = new MemoryStore();
    await syncBackup({ raw: a, api: nas, keys, account: 'carol', device: device('a'), header });
    await syncBackup({ raw: b, api: nas, keys, account: 'carol', device: device('b') });
    await a.write('athlete.json', '{"a":1}');
    await b.write('sources.json', '{"b":1}');
    // B écrit pendant que A prépare son envoi
    nas.hooks.beforePut = async () => {
      nas.hooks.beforePut = undefined;
      await syncBackup({ raw: b, api: nas, keys, account: 'carol', device: device('b') });
    };
    await syncBackup({ raw: a, api: nas, keys, account: 'carol', device: device('a') });
    expect(text(await a.read('sources.json'))).toBe('{"b":1}');
    await syncBackup({ raw: b, api: nas, keys, account: 'carol', device: device('b') });
    expect(text(await b.read('athlete.json'))).toBe('{"a":1}');
  });

  it('serveur malveillant : retour à une version déjà vue refusé ; manifeste indéchiffrable → dernier lisible', async () => {
    const nas = fakeNas();
    const a = new MemoryStore({ 'goals.json': '[]' });
    await syncBackup({ raw: a, api: nas, keys, account: 'carol', device: device('a'), header });
    await a.write('goals.json', '[{"id":"x"}]');
    await syncBackup({ raw: a, api: nas, keys, account: 'carol', device: device('a') });
    nas.replay(1);
    await expect(syncBackup({ raw: a, api: nas, keys, account: 'carol', device: device('a') })).rejects.toBeInstanceOf(Rollback);

    // Manifeste forgé par quelqu'un sans la clé (jeton volé) : ignoré, l'appareil repart du dernier lisible et le remplace
    const nas2 = fakeNas();
    const c = new MemoryStore({ 'goals.json': '[1]' });
    await syncBackup({ raw: c, api: nas2, keys, account: 'carol', device: device('c'), header });
    const thief = await workKeys(newDataKey());
    nas2.manifests.push({ version: 2, header, blob: await encryptManifest(thief, 'carol', 2, { files: {} }), objects: [] });
    const fresh = new MemoryStore();
    const r = await syncBackup({ raw: fresh, api: nas2, keys, account: 'carol', device: device('d') });
    expect(text(await fresh.read('goals.json'))).toBe('[1]');
    expect(r.version).toBe(2);
    await fresh.write('athlete.json', '{}');
    expect((await syncBackup({ raw: fresh, api: nas2, keys, account: 'carol', device: device('d') })).version).toBe(3);

    // Mauvaise clé (autre phrase de passe) : rien n'est lisible, rien n'est écrit
    const stranger = new MemoryStore();
    const otherKey = await workKeys(newDataKey());
    await expect(syncBackup({ raw: stranger, api: nas2, keys: otherKey, account: 'carol', device: device('x') })).rejects.toBeInstanceOf(TamperedData);
    expect(await stranger.keys()).toEqual([]);
  });
});
