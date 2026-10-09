import type {
  PlagClusterDetail,
  PlagDecisionCreate,
  PlagRun,
  PlagRunList,
} from '@codearena/contracts';
import { apiFetch } from './api';

/** The plagiarism review calls (S17). Admin only; the API enforces it. */
const enc = encodeURIComponent;

export const plagRuns = (signal?: AbortSignal) =>
  apiFetch<PlagRunList>('GET', '/admin/plag/runs', undefined, { auth: 'required', signal });

export const plagRun = (id: string, signal?: AbortSignal) =>
  apiFetch<PlagRun>('GET', `/admin/plag/runs/${enc(id)}`, undefined, { auth: 'required', signal });

export const startPlagRun = (contestId: string) =>
  apiFetch<PlagRun>('POST', '/admin/plag/runs', { contestId }, { auth: 'required' });

export const plagCluster = (id: string, signal?: AbortSignal) =>
  apiFetch<PlagClusterDetail>('GET', `/admin/plag/clusters/${enc(id)}`, undefined, {
    auth: 'required',
    signal,
  });

export const decideCluster = (id: string, body: PlagDecisionCreate) =>
  apiFetch<PlagClusterDetail>('POST', `/admin/plag/clusters/${enc(id)}/decisions`, body, {
    auth: 'required',
  });

/** The words the screen uses; never "cheater" (UI_UX S17). */
export const CLUSTER_STATUS_TEXT = {
  open: 'Not reviewed',
  clear: 'Cleared',
  confirm: 'Confirmed similar',
  discuss: 'Needs discussion',
} as const;

export const percent = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
