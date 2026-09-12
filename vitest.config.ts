import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      // Container-side agent runner ships as its own tsconfig/package, but its
      // pure modules are unit-tested by the root suite. Test files must never
      // live under agent-runner/src: that dir is bind-mounted into the agent
      // container and compiled there at every container start with the
      // image's tsconfig (no vitest in the image) — a stray *.test.ts there
      // breaks tsc (TS2307) and aborts every container spawn.
      'container/agent-runner/test/**/*.test.ts',
    ],
  },
});
