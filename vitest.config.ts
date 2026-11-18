import { defineConfig } from 'vitest/config'

// The suite creates real session directories, real SQLite stores and real file
// leases, so a test that moves a conversation with `verify: true` reads every
// event back — a few hundred milliseconds on an idle machine, and well past
// vitest's 5s default on a shared Windows runner (which is how CI went red on a
// tree that had just passed on the same commit). The budgets below are generous
// on purpose: a hang still fails, but a slow disk no longer does.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})