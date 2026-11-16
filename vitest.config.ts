import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
    setupFiles: ['src/test/localStorageStub.ts', 'src/test/isolateHome.ts'],
  },
});
