import { AlertCircle } from 'lucide-react';
import { useId, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

/** Labelled input; the error is announced through `aria-describedby` and never colour-only. */
export function Input({ label, error, className, id, ...props }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const errId = `${inputId}-err`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-13 text-text-2">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className={cn(
          'h-9 max-md:h-11 rounded-md border border-border-control bg-surface-1 px-3 text-14 text-text placeholder:text-text-3',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          error && 'border-danger',
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={errId} className="flex items-center gap-1 text-13 text-danger">
          <AlertCircle className="size-4" aria-hidden /> {error}
        </p>
      ) : null}
    </div>
  );
}
