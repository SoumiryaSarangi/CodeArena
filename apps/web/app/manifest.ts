import type { MetadataRoute } from 'next';
import { tokenValue } from '@/lib/token-values';

/** The web app manifest (UI-25): the name, the colours of the dark theme and the home-screen icons. */
export default function manifest(): MetadataRoute.Manifest {
  const surface = tokenValue('surface-1', 'dark');
  return {
    name: 'CodeArena',
    short_name: 'CodeArena',
    description: 'Practise, compete and run mock interviews on a judge your campus owns.',
    start_url: '/',
    display: 'standalone',
    background_color: surface,
    theme_color: surface,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
