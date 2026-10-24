import next from 'eslint-config-next';

export default [
  { ignores: ['.next/**', '.next-e2e/**', '.next-demo/**', '.demo-db/**', 'playwright-report-demo/**', '.e2e/**', 'node_modules/**', 'storage/**', 'playwright-report/**', 'test-results/**', '.claude/**', 'next-env.d.ts'] },
  ...next,
];
