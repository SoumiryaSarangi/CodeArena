'use client';
import * as T from '@radix-ui/react-tabs';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return (
    <T.List className={cn('flex gap-4 border-b border-border-strong', className)} {...props} />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        '-mb-px border-b-2 border-transparent px-1 py-2 text-14 text-text-2 transition-colors hover:text-text',
        'data-[state=active]:border-accent data-[state=active]:text-text',
        className,
      )}
      {...props}
    />
  );
}

export const TabsContent = T.Content;
