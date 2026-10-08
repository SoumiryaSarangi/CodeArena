import type {
  AdminClarificationItem,
  AdminClarificationList,
  AnnouncementSent,
  AnnouncementList,
  ClarificationAnswer,
  ClarificationCreate,
  ClarificationItem,
  ExamAdminList,
  LeaveResult,
  ClarificationList,
  AdminContestDetail,
  AdminContestList,
  BoardSnapshot,
  ContestCreate,
  ContestDetail,
  ContestList,
  ContestPatch,
  ContestProblemDetail,
  ContestProblemList,
  ContestProblemsPut,
  ContestExtendResult,
  ContestResults,
  FinalizeResult,
  RatingHistory,
  RecomputeResult,
  DlqList,
  OpsSummary,
  Rejudge,
  RejudgeResult,
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

/** `view: 'frozen'` is for the resolver and only differs from the live board for an admin. */
export const boardSnapshot = (slug: string, signal?: AbortSignal, view?: 'frozen') =>
  apiFetch<BoardSnapshot>(
    'GET',
    `/contests/${enc(slug)}/board${view ? `?view=${view}` : ''}`,
    undefined,
    {
      auth: 'optional',
      signal,
    },
  );

export const contestProblem = (slug: string, label: string, signal?: AbortSignal) =>
  apiFetch<ContestProblemDetail>(
    'GET',
    `/contests/${enc(slug)}/problems/${enc(label)}`,
    undefined,
    { auth: 'optional', signal },
  );

export const clarifications = (slug: string, signal?: AbortSignal) =>
  apiFetch<ClarificationList>('GET', `/contests/${enc(slug)}/clarifications`, undefined, {
    auth: 'required',
    signal,
  });

export const askClarification = (slug: string, body: ClarificationCreate) =>
  apiFetch<ClarificationItem>('POST', `/contests/${enc(slug)}/clarifications`, body, {
    auth: 'required',
  });

export const announcements = (slug: string, signal?: AbortSignal) =>
  apiFetch<AnnouncementList>('GET', `/contests/${enc(slug)}/announcements`, undefined, {
    auth: 'required',
    signal,
  });

export const adminInbox = (id: string, signal?: AbortSignal) =>
  apiFetch<AdminClarificationList>('GET', `/admin/contests/${enc(id)}/clarifications`, undefined, {
    auth: 'required',
    signal,
  });

export const answerClarification = (id: string, body: ClarificationAnswer) =>
  apiFetch<AdminClarificationItem>('POST', `/admin/clarifications/${enc(id)}/answer`, body, {
    auth: 'required',
  });

export const announce = (id: string, body: string) =>
  apiFetch<AnnouncementSent>(
    'POST',
    `/admin/contests/${enc(id)}/announcements`,
    { body },
    {
      auth: 'required',
    },
  );

// ---- operations (C-07, S16) ----

export const opsSummary = (signal?: AbortSignal) =>
  apiFetch<OpsSummary>('GET', '/admin/ops/summary', undefined, { auth: 'required', signal });

export const extendContest = (id: string, minutes: number) =>
  apiFetch<ContestExtendResult>(
    'POST',
    `/admin/contests/${enc(id)}/extend`,
    { minutes },
    { auth: 'required' },
  );

export const rebuildBoard = (id: string) =>
  apiFetch<{ version: number }>('POST', `/admin/contests/${enc(id)}/rebuild-board`, undefined, {
    auth: 'required',
  });

export const setProblemHidden = (id: string, label: string, hidden: boolean) =>
  apiFetch<{ hidden: boolean }>(
    'POST',
    `/admin/contests/${enc(id)}/problems/${enc(label)}/visibility`,
    { hidden },
    { auth: 'required' },
  );

export const rejudge = (body: { scope: Rejudge['scope']; id: string; urgent: boolean }) =>
  apiFetch<RejudgeResult>('POST', '/admin/rejudge', body, { auth: 'required' });

export const dlqList = (signal?: AbortSignal) =>
  apiFetch<DlqList>('GET', '/admin/dlq', undefined, { auth: 'required', signal });

export const dlqRequeue = (entryId: string) =>
  apiFetch<{ lane: string }>('POST', `/admin/dlq/${enc(entryId)}/requeue`, undefined, {
    auth: 'required',
  });

// ---- finalising and ratings (C-08) ----

export const finalizeContest = (id: string) =>
  apiFetch<FinalizeResult>('POST', `/admin/contests/${enc(id)}/finalize`, undefined, {
    auth: 'required',
  });

export const recomputeRatings = (id: string) =>
  apiFetch<RecomputeResult>('POST', `/admin/contests/${enc(id)}/recompute-ratings`, undefined, {
    auth: 'required',
  });

export const contestResults = (slug: string, signal?: AbortSignal) =>
  apiFetch<ContestResults>('GET', `/contests/${enc(slug)}/results`, undefined, {
    auth: 'optional',
    signal,
  });

export const ratingHistory = (handle: string, signal?: AbortSignal) =>
  apiFetch<RatingHistory>('GET', `/users/${enc(handle)}/ratings`, undefined, {
    auth: 'optional',
    signal,
  });

/** Exam mode (C-10): end my test. Replies with the contest as I now see it. */
export const finishExam = (slug: string) =>
  apiFetch<ContestDetail>('POST', `/contests/${enc(slug)}/finish`, undefined, { auth: 'required' });

/** Exam mode (C-10): report that the test window was left; the server counts the strike. */
export const reportLeave = (slug: string) =>
  apiFetch<LeaveResult>('POST', `/contests/${enc(slug)}/leave`, undefined, { auth: 'required' });

export const examList = (id: string, signal?: AbortSignal) =>
  apiFetch<ExamAdminList>('GET', `/admin/contests/${enc(id)}/exam`, undefined, {
    auth: 'required',
    signal,
  });

export const reopenParticipant = (id: string, userId: string) =>
  apiFetch<void>(
    'POST',
    `/admin/contests/${enc(id)}/participants/${enc(userId)}/reopen`,
    undefined,
    { auth: 'required' },
  );
