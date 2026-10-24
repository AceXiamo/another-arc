import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { trace: 'off' }
})
