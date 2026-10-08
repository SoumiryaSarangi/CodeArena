import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnnouncementBanner } from '@/components/contests/announcement-banner';
import { bannerNote } from '@/lib/contest-messages';

const note = (id: string) => ({ id, body: `Body ${id}`, createdAt: '2026-10-10T13:35:00.000Z' });

describe('C-09: which announcement the banner shows', () => {
  it('FR-CONT-04: the newest one, until it is dismissed', () => {
    const notes = [note('b'), note('a')];
    expect(bannerNote(notes, new Set(), false)?.id).toBe('b');
    expect(bannerNote(notes, new Set(['b']), false)).toBeNull();
  });

  it('FR-CONT-04: a newer announcement shows even after an older one was dismissed', () => {
    expect(bannerNote([note('c'), note('b')], new Set(['b']), false)?.id).toBe('c');
  });

  it('nothing to show: no announcements, or the contest is over', () => {
    expect(bannerNote([], new Set(), false)).toBeNull();
    expect(bannerNote([note('a')], new Set(), true)).toBeNull();
  });
});

describe('C-09: the banner', () => {
  const html = renderToStaticMarkup(<AnnouncementBanner note={note('a')} onDismiss={() => {}} />);

  it('is a status region with the text and a way to dismiss it', () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('Body a');
    expect(html).toContain('Dismiss');
  });

  it('keeps line breaks of the organiser’s message', () => {
    expect(html).toContain('whitespace-pre-line');
  });
});
