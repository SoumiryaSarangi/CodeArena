'use client';
import { ROOM_ROLE_TEXT } from '@/lib/rooms';
import type { Peer } from './use-pad';

/** Cursor labels may only carry plain characters: the name goes into a CSS string. */
const cssSafe = (s: string) => s.replace(/[^\w .-]/g, '').slice(0, 40);

/**
 * y-monaco puts `yRemoteSelection-{id}` and `yRemoteSelectionHead-{id}` on each remote cursor; this gives them the
 * person's colour (a token, by the index the server assigned) and name. Text on the flag follows UI_UX §5.1.
 */
export function PresenceStyles({ peers }: { peers: Peer[] }) {
  const css = peers
    .filter((p) => !p.self)
    .map((p) => {
      const c = `var(--presence-${p.colorIndex % 8})`;
      return `
.yRemoteSelection-${p.clientId} { background-color: color-mix(in srgb, ${c} 30%, transparent); }
.yRemoteSelectionHead-${p.clientId} { position: absolute; border-left: 2px solid ${c}; height: 100%; box-sizing: border-box; }
.yRemoteSelectionHead-${p.clientId}::after { position: absolute; top: -1.5em; left: -2px; padding: 0 4px; border-radius: 2px; font-size: 12px; line-height: 1.4; white-space: nowrap; background: ${c}; color: var(--presence-fg); content: "${cssSafe(p.name)}"; }`;
    })
    .join('\n');
  return <style data-presence>{css}</style>;
}

/** Who is here: a coloured initial plus the name and role in words (never colour alone). */
export function PresenceList({ peers }: { peers: Peer[] }) {
  return (
    <ul aria-label="People in the room" className="flex flex-wrap items-center gap-2">
      {peers.map((p) => (
        <li key={p.clientId} className="flex items-center gap-1.5 text-13">
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-full text-12 font-semibold text-[color:var(--presence-fg)]"
            style={{ background: `var(--presence-${p.colorIndex % 8})` }}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {p.name}
            {p.self ? ' (you)' : ''}
          </span>
          <span className="text-text-3">{ROOM_ROLE_TEXT[p.role]}</span>
        </li>
      ))}
    </ul>
  );
}
