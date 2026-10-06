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
      'tests/attack-suite',
      'packages/contracts/generated',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
