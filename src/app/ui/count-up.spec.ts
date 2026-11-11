import { frames } from './count-up';

describe('count-up', () => {
  it('ne fait pas défiler un chrono ou une allure depuis zéro', () => {
    expect(frames('11:30:51', null)).toBeNull();
    expect(frames('4:59', null)).toBeNull();
    expect(frames('4:59 /km', null)).toBeNull();
  });

  it('transforme un chrono d\'une valeur à l\'autre', () => {
    const f = frames('4:00', '5:00');
    expect(f?.(0)).toBe('5:00');
    expect(f?.(1)).toBe('4:00');
  });

  it('garde le défilement des nombres simples', () => {
    expect(frames('1 234', null)?.(0)).toBe('0');
  });
});
