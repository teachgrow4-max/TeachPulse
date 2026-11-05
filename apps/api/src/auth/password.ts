import { randomInt } from 'node:crypto';

/**
 * Temporary passwords handed to a new employee (or after an administrator reset). They are shown
 * once, flagged `must_change_password`, and never stored or logged by the API.
 *
 * The alphabet omits look-alike characters (0/O, 1/l/I) because these get read aloud and typed
 * from paper. 16 characters from ~56 symbols is ~93 bits of entropy.
 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const ALL = LOWER + UPPER + DIGITS;

const pick = (alphabet: string): string => alphabet[randomInt(alphabet.length)] as string;

export function generateTemporaryPassword(length = 16): string {
  if (length < 12) throw new RangeError('temporary passwords must be at least 12 characters');
  // Guarantee every class the password policy requires, then fill the rest uniformly.
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALL));
  // Fisher-Yates with a CSPRNG so the guaranteed characters do not sit in predictable positions.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
