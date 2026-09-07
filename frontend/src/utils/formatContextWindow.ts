/**
 * A context window as a human reads one: 262144 is "256K", 1048576 is "1M",
 * 256000 is "256K". Binary-first at each magnitude — LLM context sizes are
 * powers of two far more often than round decimals — but for K the decimal
 * check runs before the binary one: a value divisible by both (256000 is
 * 250 * 1024 AND 256 * 1000) is a decimal advertisement, and "256K" is what
 * its spec sheet says, never "250K".
 *
 * The exact count stays available wherever this renders, via a title
 * attribute carrying the raw number.
 */
export function formatContextWindow(value: number): string {
  if (value < 1000) return `${value}`;
  if (value % 1048576 === 0) return `${value / 1048576}M`;
  if (value % 1000000 === 0) return `${value / 1000000}M`;
  // At a million and above the unit is M, never a four-digit K: an inexact
  // divisor reads as binary megatokens to one trimmed decimal, so 1572864 is
  // "1.5M", not "1536K".
  if (value >= 1000000) return `${(value / 1048576).toFixed(1).replace(/\.0$/, '')}M`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
}
