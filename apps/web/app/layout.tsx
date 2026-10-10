import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { themeInitScript } from '@/lib/theme';
import { tokenValue } from '@/lib/token-values';
import { title } from './title';
import './globals.css';

/** Phones: draw under the notch (safe areas are padded where bars sit), colour the browser bar like ours, keep the keyboard from covering fixed bars. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: tokenValue('surface-1', 'light') },
    { media: '(prefers-color-scheme: dark)', color: tokenValue('surface-1', 'dark') },
  ],
};

export const metadata: Metadata = { title: { default: title, template: `%s · ${title}` } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Sets data-theme before first paint so there is no flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
