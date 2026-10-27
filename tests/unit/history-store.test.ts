import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryService } from '../../src/main/history/history-service'
import { Database } from '../../src/main/persistence/database'

const dbs: Array<{ db: Database; dir: string }> = []
function open(): HistoryService {
  const dir = mkdtempSync(join(tmpdir(), 'arc-history-db-'))
  const db = new Database(join(dir, 'browser.db'))
  dbs.push({ db, dir })
  return new HistoryService(db)
}
afterEach(() => {
  for (const { db, dir } of dbs.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('history favicons', () => {
  it('remembers the icon a page showed', () => {
    const h = open()
    h.recordVisit('https://github.com/electron/electron', 'Electron', false)
    h.updateFavicon('https://github.com/electron/electron', 'https://github.githubassets.com/favicons/favicon.svg')
    const [entry] = h.list('', Date.now() + 1, 10)
    expect(entry).toMatchObject({ url: 'https://github.com/electron/electron', favicon: 'https://github.githubassets.com/favicons/favicon.svg' })
  })

  it('borrows a sibling page icon, else falls back to the site /favicon.ico', () => {
    const h = open()
    const at = Date.now()
    h.store.recordVisit('https://github.com/', 'GitHub', false, at - 3000)
    h.store.updateFavicon('https://github.com/', 'https://github.githubassets.com/favicons/favicon.svg')
    h.store.recordVisit('https://github.com/vercel/next.js', 'Next.js', false, at - 2000)
    // Another origin that only starts like github.com must not borrow its icon.
    h.store.recordVisit('https://github.community/t/1', 'Forum', false, at - 1000)
    h.store.recordVisit('file:///Users/me/notes.html', 'Notes', false, at)
    const icons = Object.fromEntries(h.list('', at + 1, 10).map((e) => [e.url, e.favicon]))
    expect(icons).toEqual({
      'https://github.com/': 'https://github.githubassets.com/favicons/favicon.svg',
      'https://github.com/vercel/next.js': 'https://github.githubassets.com/favicons/favicon.svg',
      'https://github.community/t/1': 'https://github.community/favicon.ico',
      'file:///Users/me/notes.html': null
    })
    expect(h.suggest('next', 5)[0]).toMatchObject({ url: 'https://github.com/vercel/next.js', favicon: 'https://github.githubassets.com/favicons/favicon.svg' })
  })

  it('keeps data: icons out of page rows', () => {
    const h = open()
    h.recordVisit('https://example.com/', 'Example', false)
    h.updateFavicon('https://example.com/', 'data:image/png;base64,AAAA')
    expect(h.list('', Date.now() + 1, 10)[0]!.favicon).toBe('https://example.com/favicon.ico')
  })
})
