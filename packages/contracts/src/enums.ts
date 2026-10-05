import { z } from 'zod';

export const Lane = z.enum(['contest', 'interactive', 'practice', 'rejudge']).meta({ id: 'Lane' });
export type Lane = z.infer<typeof Lane>;

export const Language = z
  .enum(['c', 'cpp17', 'cpp20', 'python3', 'java21', 'node'])
  .meta({ id: 'Language' });
export type Language = z.infer<typeof Language>;

export const Verdict = z
  .enum(['AC', 'WA', 'TLE', 'MLE', 'OLE', 'RE', 'CE', 'SE'])
  .meta({ id: 'Verdict' });
export type Verdict = z.infer<typeof Verdict>;

export const JudgePhase = z
  .enum(['claimed', 'compiling', 'running', 'done'])
  .meta({ id: 'JudgePhase' });
export type JudgePhase = z.infer<typeof JudgePhase>;

export const JobMode = z.enum(['submit', 'run']).meta({ id: 'JobMode' });
export type JobMode = z.infer<typeof JobMode>;

export const CheckerKind = z
  .enum(['exact', 'tokens', 'float', 'testlib'])
  .meta({ id: 'CheckerKind' });
export type CheckerKind = z.infer<typeof CheckerKind>;
