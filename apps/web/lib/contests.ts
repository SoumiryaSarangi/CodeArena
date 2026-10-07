import type {
  AdminContestDetail,
  AdminContestList,
  ContestCreate,
  ContestDetail,
  ContestList,
  ContestPatch,
  ContestProblemList,
  ContestProblemsPut,
} from '@codearena/contracts';
import { apiFetch } from './api';

/** Contest calls (S07, S08) and the admin ones. A signed-in viewer adds `registered`. */
const enc = encodeURIComponent;

export const contestList = (signal?: AbortSignal) =>
  apiFetch<ContestList>('GET', '/contests', undefined, { auth: 'optional', signal });

export const contestDetail = (slug: string, signal?: AbortSignal) =>
  apiFetch<ContestDetail>('GET', `/contests/${enc(slug)}`, undefined, { auth: 'optional', signal });

export const contestProblems = (slug: string, signal?: AbortSignal) =>
  apiFetch<ContestProblemList>('GET', `/contests/${enc(slug)}/problems`, undefined, {
    auth: 'optional',
    signal,
  });

export const registerForContest = (slug: string) =>
  apiFetch<ContestDetail>('POST', `/contests/${enc(slug)}/register`, undefined, {
    auth: 'required',
  });

export const adminContests = (signal?: AbortSignal) =>
  apiFetch<AdminContestList>('GET', '/admin/contests', undefined, { auth: 'required', signal });

export const adminContest = (id: string, signal?: AbortSignal) =>
  apiFetch<AdminContestDetail>('GET', `/admin/contests/${enc(id)}`, undefined, {
    auth: 'required',
    signal,
  });

/** `description` and `rules` default on the server. */
export const createContest = (
  body: Omit<ContestCreate, 'description' | 'rules'> &
    Partial<Pick<ContestCreate, 'description' | 'rules'>>,
) => apiFetch<AdminContestDetail>('POST', '/admin/contests', body, { auth: 'required' });

export const patchContest = (id: string, body: ContestPatch) =>
  apiFetch<AdminContestDetail>('PATCH', `/admin/contests/${enc(id)}`, body, { auth: 'required' });

export const putContestProblems = (id: string, body: ContestProblemsPut) =>
  apiFetch<AdminContestDetail>('PUT', `/admin/contests/${enc(id)}/problems`, body, {
    auth: 'required',
  });
