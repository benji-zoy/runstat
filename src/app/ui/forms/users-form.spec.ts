import { slugId } from './users-form';

describe('proches', () => {
  it('propose un identifiant de dossier à partir du nom', () => {
    expect(slugId('Élise Martin')).toBe('elise-martin');
    expect(slugId('  Jean-Noël  ')).toBe('jean-noel');
    expect(slugId('Ça ? 2')).toBe('ca-2');
    expect(slugId('x'.repeat(40))).toHaveLength(32);
  });
});
