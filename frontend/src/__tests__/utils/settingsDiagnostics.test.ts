import { formatProfileDiagnostic } from '../../utils/settingsDiagnostics';
import type { ProfileDiagnosticCode } from '../../types/golemConfig';

// §5.6 forbids collapsing several profile-diagnostic codes onto shared copy,
// and the save flow depends on the three sentences below being distinct.
// `Record<ProfileDiagnostic['code'], string>` only enforces TOTALITY (every
// code has an entry) -- it says nothing about DISTINCTNESS, so a future edit
// could point two codes at the same sentence and no type error would catch
// it. These tests pin both properties through the public formatter, without
// widening settingsDiagnostics.ts's exported surface just to test it.

const ALL_PROFILE_DIAGNOSTIC_CODES: ProfileDiagnosticCode[] = [
  'invalid_id',
  'not_found',
  'curated_read_only',
  'store_unsafe',
  'io',
  'config_invalid',
  'active_config_invalid',
  'profile_limit',
];

describe('formatProfileDiagnostic', () => {
  it('renders the save-flow sentences by code', () => {
    expect(formatProfileDiagnostic({ code: 'curated_read_only' })).toBe(
      'Curated profiles cannot be replaced.'
    );
    expect(formatProfileDiagnostic({ code: 'profile_limit' })).toBe(
      'Too many profiles exist to create another.'
    );
    expect(formatProfileDiagnostic({ code: 'not_found' })).toBe('That profile no longer exists.');
  });

  it('gives every one of the eight closed codes its own distinct sentence', () => {
    const sentences = ALL_PROFILE_DIAGNOSTIC_CODES.map((code) => formatProfileDiagnostic({ code }));
    expect(new Set(sentences).size).toBe(ALL_PROFILE_DIAGNOSTIC_CODES.length);
  });

  it('ignores a present profileId -- the sentence is code-derived only', () => {
    expect(formatProfileDiagnostic({ code: 'io', profileId: 'user/mine' })).toBe(
      formatProfileDiagnostic({ code: 'io' })
    );
  });
});
