import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/.next',
      '**/dist',
      '**/.turbo',
      'docs',
      'apps/plag',
      'apps/worker',
      'problems',
      'apps/web/public/monaco',
      'tests/attack-suite',
      'packages/contracts/generated',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (load driver, metrics report): the runtime globals they use.
    files: ['tests/load/**/*.mjs', 'tests/chaos/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'process',
          'console',
          'fetch',
          'URL',
          'TextDecoder',
          'setTimeout',
          'performance',
          'AbortSignal',
        ].map((n) => [n, 'readonly']),
      ),
    },
  },
);
