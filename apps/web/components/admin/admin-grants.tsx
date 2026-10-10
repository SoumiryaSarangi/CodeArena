'use client';
import type { AdminGrantList, SetterGrantList } from '@codearena/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ErrorState, Skeleton } from '@/components/ui/states';
import {
  addAdminGrant,
  addSetterGrant,
  adminGrants,
  removeAdminGrant,
  removeSetterGrant,
  setterGrants,
} from '@/lib/admin';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ActionError } from './problem-errors';

type GrantList = AdminGrantList | SetterGrantList;

/** What differs between the two lists on this page. Admin wording is unchanged from FR-AUTH-12..14. */
const KINDS = {
  admin: {
    id: 'admins',
    heading: 'Admins',
    level: 1,
    formLabel: 'Add an admin',
    inputLabel: 'Email address',
    addLabel: 'Add admin',
    listLabel: 'Listed addresses',
    listHeading: 'Listed addresses',
    nowWord: 'Admin now',
    removeLabel: (e: string) => `Remove ${e}`,
    dialogTitle: 'Remove this admin?',
    dialogText: (e: string) => `${e} becomes an ordinary user.`,
    empty: 'Nobody is listed yet.',
    load: adminGrants,
    add: addAdminGrant,
    remove: removeAdminGrant,
  },
  setter: {
    id: 'setters',
    heading: 'Setters',
    level: 2,
    formLabel: 'Add a setter',
    inputLabel: "Setter's address",
    addLabel: 'Add setter',
    listLabel: 'Listed setter addresses',
    listHeading: 'Listed setters',
    nowWord: 'Setter now',
    removeLabel: (e: string) => `Remove setter ${e}`,
    dialogTitle: 'Remove this setter?',
    dialogText: (e: string) =>
      `${e} becomes an ordinary user, unless that account is an admin (an admin stays an admin).`,
    empty: 'No setters are listed yet.',
    load: setterGrants,
    add: addSetterGrant,
    remove: removeSetterGrant,
  },
} as const;

/**
 * FR-AUTH-12..17: who is admin and who is a setter. The owner lists addresses; whoever signs in with
 * one gets that role from then on (the owner's own address is always admin). Everyone else sees why
 * they cannot use this page.
 */
export function AdminGrants() {
  const { session } = useSession();
  const owner = session.status === 'authed' && session.me.isOwner;

  if (!owner) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-28 font-semibold tracking-[-0.01em]">Admins</h1>
        <p className="text-14 text-text-2">
          Only the owner of this site can choose who is an admin or a setter.
        </p>
      </div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <GrantPanel kind="admin" />
      <GrantPanel kind="setter" />
    </div>
  );
}

function GrantPanel({ kind }: { kind: keyof typeof KINDS }) {
  const k = KINDS[kind];
  const [data, setData] = useState<GrantList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [email, setEmail] = useState('');
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      k.load(signal).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e: unknown) => {
          if ((e as Error).name !== 'AbortError') setError(e as ApiError);
        },
      ),
    [k],
  );
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

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
      await k.add(email.trim());
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
      await k.remove(target);
      setConfirm(null);
      await load();
    } catch (err) {
      setConfirm(null);
      setFailure(err as Error);
    } finally {
      setBusy(false);
    }
  };

  const Heading = k.level === 1 ? 'h1' : 'h2';
  const ListHeading = k.level === 1 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={k.id} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Heading
          id={k.id}
          className={
            k.level === 1
              ? 'text-28 font-semibold tracking-[-0.01em]'
              : 'text-22 font-semibold tracking-[-0.01em]'
          }
        >
          {k.heading}
        </Heading>
        {kind === 'admin' ? (
          <p className="text-14 text-text-2">
            Anyone who signs in with a listed address becomes an admin, whether they already have an
            account or sign up later. Your own address,{' '}
            <span className="font-mono text-text">{data.owner}</span>, is always admin and is not
            listed here.
          </p>
        ) : (
          <p className="text-14 text-text-2">
            A setter writes problems: they can upload and validate their own problems and read their
            tests, but they cannot run contests, see these pages or manage anyone. Anyone who signs
            in with a listed address becomes a setter, whether they already have an account or sign
            up later. An admin is never made a setter by this list.
          </p>
        )}
      </div>

      <form onSubmit={add} aria-label={k.formLabel} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label={k.inputLabel}
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
            {k.addLabel}
          </Button>
        </div>
        <p className="text-13 text-text-3">
          Type it exactly as it appears on their account (Google treats some dots in Gmail addresses
          as the same, but this list does not). Up to {data.max} addresses.
        </p>
        {failure ? <ActionError error={failure} /> : null}
      </form>

      <div className="flex flex-col gap-2">
        <ListHeading className="text-18 font-semibold">
          {k.listHeading} ({data.grants.length})
        </ListHeading>
        {data.grants.length === 0 ? (
          <p className="text-14 text-text-2">{k.empty}</p>
        ) : (
          <ul
            aria-label={k.listLabel}
            className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1"
          >
            {data.grants.map((g) => (
              <li key={g.email} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className="min-w-0 flex-1 break-all font-mono text-14">{g.email}</span>
                <span className="text-13 text-text-2">
                  {g.signedUp ? k.nowWord : 'Waiting for their first sign-in'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={k.removeLabel(g.email)}
                  onClick={() => setConfirm(g.email)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {kind === 'admin' ? (
          <p className="text-13 text-text-3">
            Removing an address turns that account back into an ordinary user straight away (even if
            it was a setter before, unless it is also on the setter list below).
          </p>
        ) : (
          <p className="text-13 text-text-3">
            Removing an address turns a setter back into an ordinary user straight away. Every
            change is written to the audit log.
          </p>
        )}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent title={k.dialogTitle} description={k.dialogText(confirm ?? '')}>
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
