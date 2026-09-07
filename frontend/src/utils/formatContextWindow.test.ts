import { formatContextWindow } from './formatContextWindow';

describe('formatContextWindow', () => {
  it.each([
    // Binary sizes read in binary units.
    [262144, '256K'],
    [131072, '128K'],
    [32768, '32K'],
    [1048576, '1M'],
    // Decimal sizes read in decimal units.
    [1000000, '1M'],
    [200000, '200K'],
    // Divisible by both 1000 and 1024: the decimal reading wins — 256000 is
    // advertised as 256K, never 250K.
    [256000, '256K'],
    [128000, '128K'],
    // Neither: one decimal place, trailing .0 trimmed.
    [131500, '131.5K'],
    [1500, '1.5K'],
    [32769, '32.8K'],
    // At a million and above the unit is M, never a four-digit K.
    [1572864, '1.5M'],
    [2097152, '2M'],
    [2000000, '2M'],
    [1900000, '1.8M'],
    // Small values stay raw.
    [999, '999'],
    [8, '8'],
  ])('formats %i as %s', (value, expected) => {
    expect(formatContextWindow(value)).toBe(expected);
  });
});
