'use client';
import type { Verdict } from '@codearena/contracts';
import { Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DataTable, type Column } from '@/components/data-table';
import { Timer } from '@/components/timer';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { VerdictBadge } from '@/components/verdict-badge';
import { VerdictGrid, type GridTest } from '@/components/verdict-grid';

const VERDICTS: Verdict[] = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'SE'];

const GRID: GridTest[] = [
  ...Array.from({ length: 10 }, (_, i): GridTest => ({
    no: i + 1,
    state: 'AC',
    timeMs: 12 + i,
    memKb: 2048,
  })),
  { no: 11, state: 'WA', timeMs: 31, memKb: 2150 },
  { no: 12, state: 'running' },
  ...Array.from({ length: 6 }, (_, i): GridTest => ({ no: 13 + i, state: 'pending' })),
];

interface Row {
  id: string;
  handle: string;
  solved: number;
  penalty: number;
}
const ROWS: Row[] = [
  { id: '1', handle: 'tourist_', solved: 6, penalty: 412 },
  { id: '2', handle: 'ayush', solved: 5, penalty: 301 },
  { id: '3', handle: 'riya.k', solved: 5, penalty: 355 },
  { id: '4', handle: 'dev_null', solved: 3, penalty: 120 },
];
const COLUMNS: Column<Row>[] = [
  {
    key: 'handle',
    header: 'Handle',
    cell: (r) => r.handle,
    sortValue: (r) => r.handle,
    mono: true,
  },
  {
    key: 'solved',
    header: 'Solved',
    cell: (r) => r.solved,
    sortValue: (r) => r.solved,
    align: 'right',
    mono: true,
  },
  {
    key: 'penalty',
    header: 'Penalty',
    cell: (r) => r.penalty,
    sortValue: (r) => r.penalty,
    align: 'right',
    mono: true,
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <h2 className="text-20 font-semibold tracking-[-0.01em]">{title}</h2>
      {children}
    </section>
  );
}

export function KitchenSink() {
  // Fixed offsets so the three tones are always on screen.
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-24 font-semibold tracking-[-0.01em]">UI kitchen sink</h1>
        <p className="mt-1 max-w-[72ch] text-text-2">
          Every component in both themes. Use the theme toggle in the top bar, <Kbd>?</Kbd> for
          shortcuts and <Kbd>Ctrl</Kbd> <Kbd>K</Kbd> for the palette.
        </p>
      </header>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Submit</Button>
          <Button>Run</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="primary" loading>
            Submitting
          </Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm">Small 28</Button>
          <Button size="md">Medium 32</Button>
          <Button size="lg">Large 40</Button>
          <Tooltip content="New problem">
            <IconButton label="New problem">
              <Plus className="size-4" aria-hidden />
            </IconButton>
          </Tooltip>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-md gap-3">
          <Input label="Handle" placeholder="e.g. riya.k" />
          <Input label="Handle (error)" defaultValue="Ab" error="Handles are 3–20 characters." />
        </div>
      </Section>

      <Section title="Verdicts">
        <div className="flex flex-wrap items-center gap-2">
          {VERDICTS.map((v) => (
            <VerdictBadge key={v} verdict={v} />
          ))}
          <VerdictBadge verdict="pending" />
          <VerdictBadge verdict="WA" test={7} />
          <VerdictBadge verdict="TLE" test={12} />
        </div>
        <VerdictGrid tests={GRID} finalAnnouncement="" />
      </Section>

      <Section title="Timers">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-32">
          <Timer endsAt={now + 2 * 3600_000 + 5000} />
          <Timer endsAt={now + 4 * 60_000} />
          <Timer endsAt={now + 45_000} />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="console">
          <TabsList>
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
            <TabsTrigger value="subs">Submissions</TabsTrigger>
          </TabsList>
          <TabsContent value="console" className="py-3 text-text-2">
            Console output appears here.
          </TabsContent>
          <TabsContent value="tests" className="py-3 text-text-2">
            Sample tests appear here.
          </TabsContent>
          <TabsContent value="subs" className="py-3 text-text-2">
            Your submissions appear here.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Data table">
        <DataTable
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(r) => r.id}
          caption="Sample standings"
          onOpen={(r) => toast(`Opened ${r.handle}`)}
        />
      </Section>

      <Section title="Overlays and toasts">
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button>Open dialog</Button>
            </DialogTrigger>
            <DialogContent title="Delete this room?" description="This cannot be undone.">
              <div className="flex justify-end gap-2">
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Delete</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <Button>Open drawer</Button>
            </DialogTrigger>
            <DialogContent
              variant="drawer"
              title="Clarifications"
              description="Questions from this contest."
            >
              <EmptyState message="No clarifications yet. Ask if something in a statement is unclear." />
            </DialogContent>
          </Dialog>
          <Button onClick={() => toast('Submission queued')}>Show toast</Button>
        </div>
      </Section>

      <Section title="States">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-2 rounded-lg border border-border-strong p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <div className="rounded-lg border border-border-strong">
            <EmptyState
              message="No submissions yet. Pick a warm-up problem to start."
              action={<Button size="sm">Practice</Button>}
            />
          </div>
          <div className="rounded-lg border border-border-strong">
            <ErrorState requestId="7f3a91c2" onRetry={() => toast('Retrying…')} />
          </div>
        </div>
      </Section>
    </div>
  );
}
