import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, slugify } from '@/components/markdown';

const html = (md: string) => renderToStaticMarkup(<Markdown source={md} />);

describe('FR-PROB-07: statements render maths and strip anything dangerous', () => {
  it('renders inline and display maths with KaTeX', () => {
    const out = html('We need $a_i \\le 10^9$ and\n\n$$\n\\sum_{i=1}^{n} a_i\n$$\n');
    expect(out).toContain('class="katex"');
    expect(out).toContain('katex-display');
    expect(out).not.toContain('$a_i');
  });

  it('removes script, iframe, event handlers, javascript: links and style', () => {
    const out = html(
      [
        'ok',
        '<script>alert(1)</script>',
        '<iframe src="https://evil.test"></iframe>',
        '<img src=x onerror="alert(1)">',
        '[click](javascript:alert(1))',
        '<a href="javascript:alert(2)" onclick="x()">raw</a>',
        '<style>body{display:none}</style>',
        '<div style="position:fixed">x</div>',
      ].join('\n\n'),
    );
    for (const bad of [
      '<script',
      'alert(1)',
      '<iframe',
      'onerror',
      'onclick',
      'javascript:',
      '<style',
      'position:fixed',
    ])
      expect(out, bad).not.toContain(bad);
    expect(out).toContain('ok');
  });

  it('keeps ordinary Markdown: headings with anchors, lists, links, code with a copy button', () => {
    const out = html('## Input\n\n- one\n- two\n\n[docs](https://example.com)\n\n```\n3 4\n```\n');
    expect(out).toContain('<h2 id="input"');
    expect(out).toContain('href="#input"');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toContain('3 4');
  });

  it('renders every repository statement without a script or handler leaking through', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const root = new URL('../../../problems/', import.meta.url);
    const slugs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(slugs).toHaveLength(20);
    for (const d of slugs) {
      const out = html(readFileSync(new URL(`${d.name}/statement.md`, root), 'utf8'));
      expect(out, d.name).toContain('<h1');
      expect(out, d.name).not.toMatch(/<script|onerror|javascript:/i);
      expect(out, d.name).not.toContain('katex-error');
    }
  });

  it('slugifies headings', () => {
    expect(slugify('Input & Output!')).toBe('input-output');
  });
});
