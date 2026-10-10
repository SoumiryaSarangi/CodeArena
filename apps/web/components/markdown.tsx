'use client';
import 'katex/dist/katex.min.css';
import { Check, Copy } from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkMath from 'remark-math';
import { cn } from '@/lib/cn';

/**
 * FR-PROB-07 / UI_UX §7: Markdown with KaTeX, sanitised. The sanitiser runs before KaTeX so that
 * anything an author wrote (raw HTML, scripts, event handlers, `javascript:` links) is stripped;
 * only the `math-inline` / `math-display` markers that remark-math produces are let through, and
 * KaTeX's own output (generated here, not authored) is added after.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math-display']],
  },
};

const text = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object' && 'props' in node
        ? text((node as { props: { children?: ReactNode } }).props.children)
        : '';

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function Heading({
  level,
  as,
  children,
}: {
  level: 1 | 2 | 3 | 4;
  /** The tag to use when the page already has its own h1 (it keeps the size of `level`). */
  as?: 'h2';
  children?: ReactNode;
}) {
  const id = slugify(text(children));
  const Tag = as ?? (`h${level}` as const);
  const size = { 1: 'text-22', 2: 'text-18', 3: 'text-16', 4: 'text-14' }[level];
  return (
    <Tag id={id || undefined} className={cn('group mt-5 font-semibold text-text', size)}>
      {children}
      {id ? (
        <a
          href={`#${id}`}
          aria-label="Link to this section"
          className="ml-1 text-text-3 opacity-0 focus:opacity-100 group-hover:opacity-100"
        >
          #
        </a>
      ) : null}
    </Tag>
  );
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text(children).replace(/\n$/, '')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="relative my-3">
      <pre className="relative relative overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-13">
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 rounded-md border border-border-control bg-surface-1 p-1 text-text-2 hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

export function Markdown({
  source,
  className,
  demoteH1 = false,
}: {
  source: string;
  className?: string;
  /** A `# Title` in the text becomes an h2, for pages that already have an h1 (the setter's preview). */
  demoteH1?: boolean;
}) {
  return (
    <div className={cn('text-14 leading-6 text-text', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[[rehypeSanitize, schema], rehypeKatex]}
        components={{
          h1: ({ children }) => (
            <Heading level={1} {...(demoteH1 ? { as: 'h2' as const } : {})}>
              {children}
            </Heading>
          ),
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={4}>{children}</Heading>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} className="text-accent underline" rel="noopener noreferrer">
              {children}
            </a>
          ),
          code: ({ className: c, children }) =>
            c?.startsWith('language-') ? (
              <code className={c}>{children}</code>
            ) : (
              <code className="rounded-sm bg-surface-3 px-1 font-mono text-13">{children}</code>
            ),
          pre: CodeBlock,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
