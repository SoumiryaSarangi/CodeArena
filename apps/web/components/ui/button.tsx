import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const button = cva(
  'hit-44 inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[colors,transform] duration-[var(--dur-fast)] active:scale-[0.98] disabled:pointer-events-none disabled:active:scale-100',
  {
    variants: {
      variant: {
        /** Ink on paper: the one primary action of a view. */
        primary:
          'bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-surface-3 disabled:text-text-3',
        /** Blue fill, for a rare brand moment (never next to a primary). */
        accent:
          'bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-surface-3 disabled:text-text-3',
        secondary:
          'border border-border-control bg-surface-2 text-text hover:bg-surface-3 disabled:text-text-3',
        ghost: 'text-text-2 hover:bg-surface-2 hover:text-text disabled:text-text-3',
        danger: 'bg-danger text-bg hover:opacity-90 disabled:bg-surface-3 disabled:text-text-3',
      },
      size: { sm: 'h-8 px-2.5 text-13', md: 'h-9 px-3 text-14', lg: 'h-10 px-4 text-14' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
  /** Shows a spinner and keeps the button width (UI_UX §7). */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild,
  loading,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(button({ variant, size }), loading && 'relative', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          {/* Kept in the accessibility tree (not `invisible`) so the button keeps its name. */}
          <span className="inline-flex items-center gap-2 opacity-0">{children}</span>
          <Loader2
            className="absolute size-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

/** 32 px square (44 px hit area on phones); `label` is required and becomes both the accessible name and the tooltip. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: Omit<ButtonProps, 'size' | 'aria-label'> & { label: string }) {
  return (
    <Button
      variant="ghost"
      aria-label={label}
      title={label}
      className={cn('size-8 p-0', className)}
      {...props}
    >
      {children}
    </Button>
  );
}
