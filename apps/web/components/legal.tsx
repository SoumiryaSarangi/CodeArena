import type { ReactNode } from 'react';

/** Plain, readable layout for the legal pages (privacy, terms). Tokens only, no decoration. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="mx-auto flex max-w-2xl flex-col gap-4 py-6 text-14 leading-6 text-text">
      <header>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">{title}</h1>
        <p className="text-13 text-text-3">Last updated {updated}</p>
      </header>
      {children}
    </article>
  );
}

export const LegalSection = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="mt-2 text-16 font-semibold">{title}</h2>
    {children}
  </section>
);
