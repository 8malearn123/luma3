import next from 'eslint-config-next';

export default [
  { ignores: ['.next/**', '.next-e2e/**', '.next-demo/**', '.demo-db/**', 'playwright-report-demo/**', '.e2e/**', 'node_modules/**', 'storage/**', 'playwright-report/**', 'test-results/**', '.claude/**', 'next-env.d.ts'] },
  ...next,
  // Loom Marketing Core boundary (docs/LOOM_CORE.md): no LUMA domains, routes or UI inside src/loom.
  {
    files: ['src/loom/**/*.ts', 'src/loom/**/*.tsx'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/server/domains/*', '**/server/domains/**', '@/app/*', '@/ui/*', '@/shared/schemas/*'], message: 'Loom core must not import LUMA domains, routes, UI or domain schemas; read through the connector (loom_export) and write through the ActionPort.' }] }],
    },
  },
];
