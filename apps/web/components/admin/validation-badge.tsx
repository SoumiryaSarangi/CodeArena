import { cn } from '@/lib/cn';

const LABEL = {
  passed: { text: 'Validated', cls: 'text-v-ac' },
  failed: { text: 'Validation failed', cls: 'text-v-wa' },
  running: { text: 'Validating…', cls: 'text-v-pending' },
  pending: { text: 'Not validated', cls: 'text-text-3' },
} as const;

/** The version's validation state as text first (never colour alone). */
export function ValidationBadge({
  status,
  className,
}: {
  status: keyof typeof LABEL | null;
  className?: string;
}) {
  if (status === null) return <span className="text-text-3">—</span>;
  const l = LABEL[status];
  return <span className={cn('text-13 font-medium', l.cls, className)}>{l.text}</span>;
}
