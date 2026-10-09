import type { RoomTimelineEvent } from '@codearena/contracts';
import { isLanguage, languageInfo } from './languages';
import { clock } from './rooms';
import { verdictTitle } from './verdicts';

/** The words for a marker or an event in the replay: always text, never only a colour or a shape. */
export function eventLabel(e: RoomTimelineEvent): string {
  const who = e.by ? `@${e.by}` : 'Someone';
  switch (e.kind) {
    case 'join':
      return `${who} joined`;
    case 'leave':
      return `${who} left`;
    case 'language':
      return `Language changed to ${e.language && isLanguage(e.language) ? languageInfo(e.language).label : (e.language ?? 'another')}`;
    case 'run': {
      const what = e.mode === 'submit' ? 'submitted' : 'ran';
      return `${who} ${what}${e.verdict ? `: ${verdictTitle(e.verdict)}` : ''}`;
    }
    case 'snapshot':
      return 'Version saved';
    case 'restore':
      return 'Version restored';
    case 'timer':
      return 'Timer';
  }
}

/** "12:03" into the session. */
export const sessionClock = (ms: number, startMs: number) => clock((ms - startMs) / 1000);
