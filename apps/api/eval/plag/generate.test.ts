import { describe, expect, it } from 'vitest';
import { extractCode, haveKey, LANGUAGES, PERSONAS, prompt } from './generate';

describe('PL-03: independent solution generator', () => {
  it('takes the program from the first fenced block, with or without a language tag', () => {
    expect(extractCode('Here:\n```cpp\nint main(){}\n```\nDone.')).toBe('int main(){}');
    expect(extractCode('```\nprint(1)\n```')).toBe('print(1)');
    expect(extractCode('```python\na\n```\n```python\nb\n```')).toBe('a');
    expect(extractCode('  just code  ')).toBe('just code');
  });

  it('asks for one program in the language and style, and puts the statement in the user message', () => {
    const m = prompt('python3', 2, '# Problem\nSum.');
    expect(m[0]!.content).toContain(PERSONAS[2]);
    expect(m[0]!.content).toContain(LANGUAGES.python3);
    expect(m[1]).toEqual({ role: 'user', content: '# Problem\nSum.' });
    expect(PERSONAS).toHaveLength(4);
    // the pseudo-code answers of the first pass are asked not to happen again
    expect(m[0]!.content).toMatch(/compilable/);
    expect(m[0]!.content).toMatch(/never pseudo-code/);
  });

  it('names a finished slot so a resumed run can skip it', () => {
    expect(haveKey('maze-runner', 'cpp17', 2)).toBe('maze-runner:cpp17:2');
  });
});
