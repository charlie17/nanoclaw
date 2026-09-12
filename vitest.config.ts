import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // Container-side agent runner ships as its own tsconfig/package, but its
      // pure modules are unit-tested by the root suite.
      'container/agent-runner/src/**/*.test.ts',
    ],
  },
});
