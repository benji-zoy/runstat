import { clock, parseDuration, parseKmList } from './format';

describe('parseDuration', () => {
  it('lit les formats usuels', () => {
    expect(parseDuration('1:35:00')).toBe(5700);
    expect(parseDuration('35:20')).toBe(2120);
    expect(parseDuration('1h35')).toBe(5700);
    expect(parseDuration('10 h 30')).toBe(37800);
    expect(parseDuration("1h35'20")).toBe(5720);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration("95'")).toBe(5700);
    expect(parseDuration('95 min')).toBe(5700);
    expect(parseDuration('95')).toBe(5700);
    expect(parseDuration("42'30")).toBe(2550);
  });

  it('refuse le reste', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('1:75')).toBeNull();
    expect(parseDuration('1h75')).toBeNull();
  });

  it('relit ce que clock affiche', () => {
    for (const sec of [59, 2120, 5790, 37800]) expect(parseDuration(clock(sec))).toBe(sec);
  });
});

describe('parseKmList', () => {
  it('sépare les kilomètres, garde la virgule décimale', () => {
    expect(parseKmList('7, 14, 21,5')).toEqual([7, 14, 21.5]);
    expect(parseKmList('14 ; 7')).toEqual([7, 14]);
    expect(parseKmList('7,')).toEqual([7]);
    expect(parseKmList('7, x')).toBeNull();
  });
});
