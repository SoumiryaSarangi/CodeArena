import { describe, expect, it } from 'vitest';
import { applyEdits, diffText, MAX_EDIT_DISTANCE } from './text-diff';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = ['a', 'b', 'c', ' ', '\n', 'é', '日', '😀', '𝒳'];
const random = (r: () => number, len: number) =>
  Array.from({ length: len }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join('');

describe('FR-PAD-12: the edit script that restores a snapshot', () => {
  it('FR-PAD-12: applying the edits to the old text gives the new text, for 500 random pairs', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const a = random(r, Math.floor(r() * 40));
      // half the pairs are small mutations of each other, half are unrelated
      const b =
        r() < 0.5
          ? a.slice(0, Math.floor(r() * a.length)) +
            random(r, Math.floor(r() * 4)) +
            a.slice(Math.floor(r() * a.length))
          : random(r, Math.floor(r() * 40));
      expect(applyEdits(a, diffText(a, b)), `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBe(b);
    }
  });

  it('FR-PAD-12: equal texts need no edits', () => {
    expect(diffText('same', 'same')).toEqual([]);
    expect(diffText('', '')).toEqual([]);
  });

  it('FR-PAD-12: one changed character is one small edit, not a replacement of the text', () => {
    const base = 'int main() {\n  return 0;\n}\n'.repeat(20);
    const changed = base.replace('return 0;', 'return 1;');
    const edits = diffText(base, changed);
    expect(edits).toEqual([{ index: base.indexOf('return 0;') + 7, delete: 1, insert: '1' }]);
  });

  it('FR-PAD-12: text added or removed at the ends and from nothing', () => {
    expect(applyEdits('', diffText('', 'abc'))).toBe('abc');
    expect(applyEdits('abc', diffText('abc', ''))).toBe('');
    expect(diffText('abc', 'abcdef')).toEqual([{ index: 3, delete: 0, insert: 'def' }]);
    expect(diffText('abcdef', 'def')).toEqual([{ index: 0, delete: 3, insert: '' }]);
  });

  it('FR-PAD-12: an edit never splits a surrogate pair', () => {
    const a = 'x😀y😀z';
    const b = 'x😁y😀z';
    const edits = diffText(a, b);
    expect(applyEdits(a, edits)).toBe(b);
    for (const e of edits) {
      expect(e.delete % 2 === 0 || !/[\ud800-\udfff]/.test(e.insert)).toBe(true);
      expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(e.insert)).toBe(false);
      expect(e.insert).toBe(e.insert.normalize()); // well formed
    }
    expect(edits).toEqual([{ index: 1, delete: 2, insert: '😁' }]);
  });

  it('FR-PAD-12: past the cost limit it replaces the middle whole and still gets the text right', () => {
    const a = random(rng(11), 300);
    const b = random(rng(12), 300);
    const edits = diffText(a, b, 50);
    expect(applyEdits(a, edits)).toBe(b);
    expect(edits).toHaveLength(1);
    // the default limit handles an ordinary large rewrite exactly
    const big = random(rng(3), 3000);
    const other = big.slice(0, 1000) + 'INSERTED' + big.slice(1010);
    expect(applyEdits(big, diffText(big, other))).toBe(other);
    expect(MAX_EDIT_DISTANCE).toBeGreaterThan(100);
  });
});
