import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Copilot/ACP integration tests spawn processes; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
