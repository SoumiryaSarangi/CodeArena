import type {
  AdminGrantList,
  SetterGrantList,
  AdminProblemDetail,
  AdminProblemList,
  StatementPatch,
  TestsList,
  UploadResult,
  ValidationRun,
} from '@codearena/contracts';
import { apiBlob, apiFetch } from './api';
import { buildForm, type PackageFile } from './package-folder';

/** Setter/admin calls (S15). Uploads and downloads go straight to the API host (see `direct`). */
const slugPath = (slug: string) => encodeURIComponent(slug);

export const adminProblems = (signal?: AbortSignal) =>
  apiFetch<AdminProblemList>('GET', '/admin/problems', undefined, { auth: 'required', signal });

export const adminProblem = (slug: string, signal?: AbortSignal) =>
  apiFetch<AdminProblemDetail>('GET', `/admin/problems/${slugPath(slug)}`, undefined, {
    auth: 'required',
    signal,
  });

export const uploadPackage = (slug: string, files: PackageFile[], signal?: AbortSignal) =>
  apiFetch<UploadResult>('POST', '/admin/problems/packages', buildForm(slug, files), {
    auth: 'required',
    direct: true,
    signal,
  });

export const saveStatement = (slug: string, body: StatementPatch) =>
  apiFetch<UploadResult>('PATCH', `/admin/problems/${slugPath(slug)}/statement`, body, {
    auth: 'required',
  });

export const setVisibility = (slug: string, visibility: 'private' | 'contest' | 'public') =>
  apiFetch<{ slug: string; visibility: string }>(
    'PATCH',
    `/admin/problems/${slugPath(slug)}/visibility`,
    { visibility },
    { auth: 'required' },
  );

export const listTests = (versionId: string, signal?: AbortSignal) =>
  apiFetch<TestsList>('GET', `/admin/problem-versions/${versionId}/tests`, undefined, {
    auth: 'required',
    signal,
  });

export const startValidation = (versionId: string) =>
  apiFetch<ValidationRun>('POST', `/admin/problem-versions/${versionId}/validate`, undefined, {
    auth: 'required',
  });

export const validationRun = (id: string, signal?: AbortSignal) =>
  apiFetch<ValidationRun>('GET', `/admin/validation-runs/${id}`, undefined, {
    auth: 'required',
    signal,
  });

/** Downloads `tests.tar` or one `NN.in` / `NN.ans`: fetched with the token, then saved as a file. */
export async function downloadTests(versionId: string, file: string | 'tests.tar'): Promise<void> {
  const path =
    file === 'tests.tar'
      ? `/admin/problem-versions/${versionId}/tests.tar`
      : `/admin/problem-versions/${versionId}/tests/${file}`;
  const { blob, filename } = await apiBlob(path, { auth: 'required', direct: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? file;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** FR-AUTH-12..14: the owner's list of addresses that become admin when they sign in. */
export const adminGrants = (signal?: AbortSignal) =>
  apiFetch<AdminGrantList>('GET', '/admin/admins', undefined, { auth: 'required', signal });

export const addAdminGrant = (email: string) =>
  apiFetch<void>('POST', '/admin/admins', { email }, { auth: 'required' });

export const removeAdminGrant = (email: string) =>
  apiFetch<void>('DELETE', `/admin/admins/${encodeURIComponent(email)}`, undefined, {
    auth: 'required',
  });

/** FR-AUTH-15..17: the owner's list of addresses that become setters (problem authors) when they sign in. */
export const setterGrants = (signal?: AbortSignal) =>
  apiFetch<SetterGrantList>('GET', '/admin/setters', undefined, { auth: 'required', signal });

export const addSetterGrant = (email: string) =>
  apiFetch<void>('POST', '/admin/setters', { email }, { auth: 'required' });

export const removeSetterGrant = (email: string) =>
  apiFetch<void>('DELETE', `/admin/setters/${encodeURIComponent(email)}`, undefined, {
    auth: 'required',
  });
