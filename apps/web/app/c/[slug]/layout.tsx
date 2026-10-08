import type { ReactNode } from 'react';
import { ContestMessagesProvider } from '@/lib/contest-messages';

type Props = { children: ReactNode; params: Promise<{ slug: string }> };

/** Everything under /c/{slug}: lobby, problems, board. Announcements reach all of it (C-09). */
export default async function ContestLayout({ children, params }: Props) {
  const { slug } = await params;
  return <ContestMessagesProvider slug={slug}>{children}</ContestMessagesProvider>;
}
