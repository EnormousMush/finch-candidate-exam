import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // 所有测试共用一个测试库，按文件串行执行，避免互相清表
    fileParallelism: false,
    testTimeout: 20000,
  },
});
