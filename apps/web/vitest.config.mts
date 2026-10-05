import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  // tsconfig keeps `jsx: preserve` for Next, so tests opt into the automatic runtime here.
  oxc: { jsx: { runtime: 'automatic' } },
});
