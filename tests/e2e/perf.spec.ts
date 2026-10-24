import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, ROOT, rpc, startServer, tempDir, waitForShown } from './helpers'

// Performance baseline. Numbers are written to test-results/perf.json; the
// assertions are loose budgets that catch regressions, not benchmarks.

const metricsMB = (app: Parameters<typeof inMain>[0]) =>
  inMain(app, (_b, _a, electron) => {
    const byType: Record<string, number> = {}
    let total = 0
    for (const m of electron.app.getAppMetrics()) {
      const mb = m.memory.workingSetSize / 1024
      byType[m.type] = Math.round((byType[m.type] ?? 0) + mb)
      total += mb
    }
    return { totalMB: Math.round(total), byType, processes: electron.app.getAppMetrics().length }
  })

test('startup, memory and IPC baseline', async () => {
  test.setTimeout(240_000)
  const { url, server } = await startServer()
  const userData = tempDir()
  const report: Record<string, unknown> = {}
  try {
    // Cold start (empty profile, no compile/code cache yet).
    let run = await launch(userData)
    await new Promise((r) => setTimeout(r, 500))
    report.coldStart = await inMain(run.app, (b) => b.startupMarks())
    report.idleMemory = await metricsMB(run.app)

    // One page, then ten.
    await rpc(run.shell, 'tabs.create', { url: `${url}/page/p0` })
    await waitForShown(run.app, '/page/p0')
    const before = await inMain(run.app, (b) => b.shell.messages)
    await rpc(run.shell, 'tabs.create', { url: `${url}/page/ipc` })
    await waitForShown(run.app, '/page/ipc')
    await new Promise((r) => setTimeout(r, 800))
    report.ipcMessagesForOnePageLoad = (await inMain(run.app, (b) => b.shell.messages)) - before
    for (let i = 1; i < 10; i++) await rpc(run.shell, 'tabs.create', { url: `${url}/page/p${i}`, background: true })
    await new Promise((r) => setTimeout(r, 2000))
    report.tenTabsMemory = await metricsMB(run.app)

    // Discard all background tabs and measure again.
    await inMain(run.app, (b) => {
      for (const t of b.tabs.discardCandidates()) b.tabs.discardTab(t.id)
    })
    await new Promise((r) => setTimeout(r, 2500))
    report.afterDiscardMemory = await metricsMB(run.app)
    report.liveTabsAfterDiscard = await inMain(run.app, (b) => b.tabs.liveRuntimes().length)

    // Tab switch: main-side time to present a live background tab.
    const ids = (await inMain(run.app, (b) => b.tabs.model.orderedTabIds(b.tabs.model.activeSpaceId))) as string[]
    report.tabSwitchMs = await inMain(
      run.app,
      async (b, tabIds: string[]) => {
        const samples: number[] = []
        for (const id of tabIds.slice(0, 5)) {
          const t0 = performance.now()
          b.tabs.activateTab(id)
          await Promise.resolve()
          samples.push(performance.now() - t0)
        }
        return Math.round((samples.reduce((a, c) => a + c, 0) / samples.length) * 100) / 100
      },
      ids
    )
    await quit(run.app)

    // Warm start (compile cache + V8 code cache populated, 10 tabs to restore).
    run = await launch(userData)
    await new Promise((r) => setTimeout(r, 500))
    report.warmStart = await inMain(run.app, (b) => b.startupMarks())
    report.warmStartLiveTabs = await inMain(run.app, (b) => b.tabs.liveRuntimes().length)
    report.warmStartMemory = await metricsMB(run.app)
    await quit(run.app)
  } finally {
    server.close()
    removeDir(userData)
  }

  const dir = join(ROOT, 'test-reports')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'perf.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))

  const warm = report.warmStart as Record<string, number>
  expect(warm['shell-first-paint']).toBeLessThan(2000)
  expect(report.warmStartLiveTabs).toBe(1)
  expect(report.ipcMessagesForOnePageLoad as number).toBeLessThan(12)
})
