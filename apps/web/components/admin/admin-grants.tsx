'use client';
import type { AdminGrantList } from '@codearena/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { addAdminGrant, adminGrants, removeAdminGrant } from '@/lib/admin';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ActionError } from './problem-errors';

/**
 * FR-AUTH-12..14: who is admin. The owner lists addresses; whoever signs in with one is admin from
 * then on (the owner's own address always is). Everyone else sees why they cannot use this page.
 */
export function AdminGrants() {
  const { session } = useSession();
  const owner = session.status === 'authed' && session.me.isOwner;
  const [data, setData] = useState<AdminGrantList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [email, setEmail] = useState('');
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      adminGrants(signal).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e: unknown) => {
          if ((e as Error).name !== 'AbortError') setError(e as ApiError);
        },
      ),
    [],
  );
  useEffect(() => {
    if (!owner) return;
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [owner, load]);

  if (!owner) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-28 font-semibold tracking-[-0.01em]">Admins</h1>
        <p className="text-14 text-text-2">
          Only the owner of this site can choose who is an admin.
        </p>
      </div>
    );
  }
  if (error)
    return (
      <ErrorState message={error.message} requestId={error.requestId} onRetry={() => void load()} />
    );
  if (!data) return <Skeleton className="h-64 w-full" />;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await addAdminGrant(email.trim());
      setEmail('');
      await load();
    } catch (err) {
      setFailure(err as Error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (target: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await removeAdminGrant(target);
      setConfirm(null);
      await load();
    } catch (err) {
      setConfirm(null);
      setFailure(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="admins" className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 id="admins" className="text-28 font-semibold tracking-[-0.01em]">
          Admins
        </h1>
        <p className="text-14 text-text-2">
          Anyone who signs in with a listed address becomes an admin, whether they already have an
          account or sign up later. Your own address,{' '}
          <span className="font-mono text-text">{data.owner}</span>, is always admin and is not
          listed here.
        </p>
      </div>

      <form onSubmit={add} aria-label="Add an admin" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Email address"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder="name@gmail.com"
            className="w-72 max-w-full"
          />
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={email.trim() === '' || data.grants.length >= data.max}
          >
            Add admin
          </Button>
        </div>
        <p className="text-13 text-text-3">
          Type it exactly as it appears on their account (Google treats some dots in Gmail addresses
          as the same, but this list does not). Up to {data.max} addresses.
        </p>
        {failure ? <ActionError error={failure} /> : null}
      </form>

      <div className="flex flex-col gap-2">
        <h2 className="text-18 font-semibold">Listed addresses ({data.grants.length})</h2>
        {data.grants.length === 0 ? (
          <p className="text-14 text-text-2">Nobody is listed yet.</p>
        ) : (
          <ul
            aria-label="Listed addresses"
            className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1"
          >
            {data.grants.map((g) => (
              <li key={g.email} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="min-w-0 flex-1 break-all font-mono text-14">{g.email}</span>
                <span className="text-13 text-text-2">
                  {g.signedUp ? 'Admin now' : 'Waiting for their first sign-in'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${g.email}`}
                  onClick={() => setConfirm(g.email)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-13 text-text-3">
          Removing an address turns that account back into an ordinary user straight away (even if
          it was a setter before).
        </p>
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent
          title="Remove this admin?"
          description={`${confirm ?? ''} becomes an ordinary user.`}
        >
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Keep
            </Button>
            <Button variant="danger" loading={busy} onClick={() => confirm && void remove(confirm)}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
