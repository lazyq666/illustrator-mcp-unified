import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Unit tests must not read the real process table; probe tests stub it explicitly.
    env: { ILLUSTRATOR_MCP_PROCESS_PROBE: '0' },
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
  },
});
