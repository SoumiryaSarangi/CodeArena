'use client';
import { useContestMessagesContext } from '@/lib/contest-messages';
import { ClarificationsDrawer } from './clarifications-drawer';

/** The Clarifications button of the contest pages (lobby, problems, board), fed by the shared provider. */
export function ContestMessagesButton({
  labels,
  canAsk,
  defaultLabel,
}: {
  labels: string[];
  canAsk: boolean;
  defaultLabel?: string;
}) {
  const ctx = useContestMessagesContext();
  if (!ctx?.active) return null;
  const m = ctx.messages;
  return (
    <ClarificationsDrawer
      slug={ctx.slug}
      labels={labels}
      items={m.items}
      notes={m.notes}
      unread={m.unread}
      unreadIds={m.unreadIds}
      canAsk={canAsk}
      onAsked={m.added}
      onOpen={m.markRead}
      defaultLabel={defaultLabel}
    />
  );
}
