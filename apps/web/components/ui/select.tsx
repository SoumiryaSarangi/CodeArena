import { useId, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
}

/** Native select (best keyboard and screen-reader support) in the Input's visual style. */
export function Select({ label, className, id, children, ...props }: SelectProps) {
  const auto = useId();
  const selectId = id ?? auto;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="text-13 text-text-2">
        {label}
      </label>
      <select
        id={selectId}
        className={cn(
          'h-8 rounded-md border border-border-control bg-surface-1 px-2 text-14 text-text',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
