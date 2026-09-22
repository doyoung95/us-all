import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.load-spec.ts'],
    // 이 스위트의 결과물은 리포트다. 통과해도 stdout 이 보여야 한다
    disableConsoleIntercept: true,
    reporters: ['verbose'],
    // 부하 시나리오는 한 번에 하나만 돌아야 수치가 의미 있다
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
