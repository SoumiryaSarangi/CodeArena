import type { Verdict } from '@codearena/contracts';

export interface VerdictMeta {
  label: Verdict;
  name: string;
  /** Appended with "on test N" when a failing test number is known. */
  perTest: boolean;
  /** Full class strings so Tailwind's scanner sees them. */
  text: string;
  tint: string;
  swatch: string;
}

/**
 * Dark badges use a 14% tint (UI_UX §5.1). In the light theme the verdict colours sit at ~4.6:1 on
 * the page, so any tint pushes the label below 4.5:1: light badges use a hairline ring instead.
 *
 * Copy from SRS Appendix A / UI_UX §10.2. The text label is always rendered next to the colour.
 */
export const VERDICTS: Record<Verdict, VerdictMeta> = {
  AC: {
    label: 'AC',
    name: 'Accepted',
    perTest: false,
    text: 'text-v-ac',
    tint: 'bg-v-ac/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-ac/40',
    swatch: 'bg-v-ac',
  },
  WA: {
    label: 'WA',
    name: 'Wrong answer',
    perTest: true,
    text: 'text-v-wa',
    tint: 'bg-v-wa/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-wa/40',
    swatch: 'bg-v-wa',
  },
  TLE: {
    label: 'TLE',
    name: 'Time limit exceeded',
    perTest: true,
    text: 'text-v-tle',
    tint: 'bg-v-tle/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-tle/40',
    swatch: 'bg-v-tle',
  },
  MLE: {
    label: 'MLE',
    name: 'Memory limit exceeded',
    perTest: true,
    text: 'text-v-mle',
    tint: 'bg-v-mle/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-mle/40',
    swatch: 'bg-v-mle',
  },
  RE: {
    label: 'RE',
    name: 'Runtime error',
    perTest: true,
    text: 'text-v-re',
    tint: 'bg-v-re/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-re/40',
    swatch: 'bg-v-re',
  },
  CE: {
    label: 'CE',
    name: 'Compilation error',
    perTest: false,
    text: 'text-v-ce',
    tint: 'bg-v-ce/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-ce/40',
    swatch: 'bg-v-ce',
  },
  OLE: {
    label: 'OLE',
    name: 'Output limit exceeded',
    perTest: true,
    text: 'text-v-ole',
    tint: 'bg-v-ole/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-ole/40',
    swatch: 'bg-v-ole',
  },
  SE: {
    label: 'SE',
    name: 'System error',
    perTest: false,
    text: 'text-v-se',
    tint: 'bg-v-se/14 light:bg-transparent light:ring-1 light:ring-inset light:ring-v-se/40',
    swatch: 'bg-v-se',
  },
};

export function verdictTitle(v: Verdict, test?: number): string {
  const m = VERDICTS[v];
  return m.perTest && test !== undefined ? `${m.name} on test ${test}` : m.name;
}
