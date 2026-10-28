import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import type { DownloadEntry, DownloadManager, DownloadObserver, DownloadRequest } from '../../src/main/downloads/download-manager'
import {
  checkFilename,
  checkHeaders,
  checkOptions,
  diffItems,
  ExtensionDownloads,
  orderAndLimit,
  queryMatcher,
  toChromeItem,
  type ChromeDownloadItem
} from '../../src/main/extensions/downloads'
import type { DownloadState } from '@shared/types'

const EXT = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'

function entry(seq: number, patch: Partial<DownloadState> = {}, extra: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    state: {
      id: `d${seq}`,
      url: `https://pbs.twimg.com/media/${seq}.jpg`,
      filename: `${seq}.jpg`,
      savePath: `/Users/me/Downloads/${seq}.jpg`,
      status: 'progressing',
      paused: false,
      receivedBytes: 10,
      totalBytes: 100,
      startedAt: Date.UTC(2026, 9, 29, 0, 0, seq),
      endedAt: null,
      ...patch
    },
    seq,
    initiator: null,
    finalUrl: `https://pbs.twimg.com/media/${seq}.jpg`,
    mime: 'image/jpeg',
    canResume: false,
    error: null,
    ...extra
  }
}

describe('checkFilename', () => {
  it('accepts names and paths under the download folder', () => {
    expect(checkFilename('twitter_鳴上響(@P0gvmL)_20261028-210002_photo.jpg')).toBe('twitter_鳴上響(@P0gvmL)_20261028-210002_photo.jpg')
    expect(checkFilename('Twitter/2026/a.mp4')).toBe('Twitter/2026/a.mp4')
  })

  it('refuses what Chrome refuses', () => {
    for (const bad of ['', '/etc/passwd', '../a.jpg', 'a/../../b', 'a//b', './a', '~/a', 'a:b.jpg', 'a?.jpg', 'a\\b', 'trailing.', ' lead', 'CON', 'nul.txt', 'a‮gpj.exe', 'x'.repeat(256)]) {
      expect(() => checkFilename(bad), bad).toThrow('Invalid filename')
    }
  })
})

describe('checkHeaders', () => {
  it('turns the header list into a record', () => {
    expect(checkHeaders([{ name: 'X-Token', value: 'abc' }])).toEqual({ 'X-Token': 'abc' })
    expect(checkHeaders(undefined)).toBeUndefined()
    expect(checkHeaders([])).toBeUndefined()
  })

  it('refuses headers XMLHttpRequest may not set', () => {
    for (const name of ['Cookie', 'referer', 'Host', 'Sec-Fetch-Mode', 'Proxy-Authorization']) {
      expect(() => checkHeaders([{ name, value: 'x' }]), name).toThrow('Unsafe request header name')
    }
    expect(() => checkHeaders([{ name: 'X-A', value: 'a\r\nb' }])).toThrow('Invalid header')
    expect(() => checkHeaders({ name: 'X-A' })).toThrow('Invalid header')
  })
})

describe('checkOptions', () => {
  it('fills in defaults', () => {
    expect(checkOptions({ url: 'https://a.test/x.jpg' })).toEqual({
      url: 'https://a.test/x.jpg',
      filename: undefined,
      conflictAction: 'uniquify',
      saveAs: undefined,
      method: 'GET',
      headers: undefined,
      body: undefined
    })
  })

  it('refuses bad URLs and enum values', () => {
    expect(() => checkOptions({ url: 'not a url' })).toThrow('Invalid URL')
    expect(() => checkOptions({ url: 'file:///etc/hosts' })).toThrow('Invalid URL')
    expect(() => checkOptions({ url: 'javascript:alert(1)' })).toThrow('Invalid URL')
    expect(() => checkOptions({ url: 'https://a.test', conflictAction: 'replace' })).toThrow('Invalid conflictAction')
    expect(() => checkOptions({ url: 'https://a.test', method: 'PUT' })).toThrow('Invalid method')
    expect(() => checkOptions({ url: 'https://a.test', filename: '../x' })).toThrow('Invalid filename')
  })
})

describe('toChromeItem', () => {
  it('maps an in-progress download', () => {
    const item = toChromeItem(entry(1), true)
    expect(item).toMatchObject({
      id: 1,
      state: 'in_progress',
      filename: '/Users/me/Downloads/1.jpg',
      bytesReceived: 10,
      totalBytes: 100,
      fileSize: 100,
      danger: 'safe',
      exists: true,
      startTime: '2026-10-29T00:00:01.000Z'
    })
    expect(item.endTime).toBeUndefined()
    expect(item.error).toBeUndefined()
  })

  it('reports how a download ended and who started it', () => {
    const done = toChromeItem(entry(2, { status: 'completed', receivedBytes: 100, endedAt: Date.UTC(2026, 9, 29, 0, 1) }, { initiator: EXT }), true, 'Tampermonkey')
    expect(done).toMatchObject({ state: 'complete', endTime: '2026-10-29T00:01:00.000Z', byExtensionId: EXT, byExtensionName: 'Tampermonkey' })
    expect(toChromeItem(entry(3, { status: 'cancelled' }, { error: 'USER_CANCELED' }), false)).toMatchObject({ state: 'interrupted', error: 'USER_CANCELED' })
    // Unknown size reads -1, as in Chrome.
    expect(toChromeItem(entry(4, { totalBytes: 0 }), true)).toMatchObject({ totalBytes: -1, fileSize: -1 })
  })
})

describe('diffItems', () => {
  it('reports changed fields with previous and current values', () => {
    const before = toChromeItem(entry(1), true)
    const after = toChromeItem(entry(1, { status: 'completed', receivedBytes: 100, endedAt: Date.UTC(2026, 9, 29, 0, 2) }), true)
    expect(diffItems(before, after)).toEqual({
      id: 1,
      state: { previous: 'in_progress', current: 'complete' },
      endTime: { current: '2026-10-29T00:02:00.000Z' }
    })
  })

  it('ignores progress alone', () => {
    expect(diffItems(toChromeItem(entry(1), true), toChromeItem(entry(1, { receivedBytes: 50 }), true))).toBeNull()
  })
})

describe('search queries', () => {
  const items: ChromeDownloadItem[] = [
    toChromeItem(entry(1, { status: 'completed', receivedBytes: 100, endedAt: Date.UTC(2026, 9, 29, 1) }), true),
    toChromeItem(entry(2), true),
    toChromeItem(entry(3, { url: 'https://video.twimg.com/a.mp4', savePath: '/Users/me/Downloads/a.mp4', totalBytes: 5000 }), true)
  ]
  const search = (q: unknown) => orderAndLimit(items.filter(queryMatcher(q)), q).map((i) => i.id)

  it('matches exact fields, regexes, terms and ranges', () => {
    expect(search({ id: 2 })).toEqual([2])
    expect(search({ state: 'complete' })).toEqual([1])
    expect(search({ filenameRegex: '\\.mp4$' })).toEqual([3])
    expect(search({ query: ['twimg', '-video'] })).toEqual([2, 1])
    expect(search({ totalBytesGreater: 1000 })).toEqual([3])
    expect(search({ endedAfter: '2026-10-29T00:30:00Z' })).toEqual([1])
    expect(search({ startedBefore: Date.UTC(2026, 9, 29, 0, 0, 2) })).toEqual([1])
  })

  it('orders newest first by default, honours orderBy and limit', () => {
    expect(search({})).toEqual([3, 2, 1])
    expect(search({ orderBy: ['startTime'] })).toEqual([1, 2, 3])
    expect(search({ orderBy: ['-totalBytes', 'startTime'], limit: 2 })).toEqual([3, 1])
    expect(search({ limit: 0 })).toEqual([3, 2, 1])
  })

  it('refuses malformed queries', () => {
    expect(() => queryMatcher({ filenameRegex: '(' })).toThrow('Invalid query regex')
    expect(() => orderAndLimit(items, { orderBy: ['size'] })).toThrow('Invalid orderBy field')
  })
})

/** A DownloadManager stand-in: entries in memory, calls recorded. */
function fakeManager() {
  const entries = new Map<string, DownloadEntry>()
  const calls: string[] = []
  let observer: DownloadObserver | null = null
  let next = 1
  const manager = {
    setObserver: (o: DownloadObserver) => void (observer = o),
    entries: () => [...entries.values()],
    entry: (id: string) => entries.get(id),
    start: async (_ses: Session, request: DownloadRequest) => {
      const e = entry(next++, { url: request.url }, { initiator: request.initiator ?? null })
      entries.set(e.state.id, e)
      observer?.created(e)
      return e.state.id
    },
    saveData: async (data: Uint8Array, request: DownloadRequest) => {
      const e = entry(next++, { url: request.url, totalBytes: data.byteLength }, { initiator: request.initiator ?? null })
      entries.set(e.state.id, e)
      observer?.created(e)
      return e.state.id
    },
    cancel: (id: string) => void calls.push(`cancel ${id}`),
    pause: (id: string) => void calls.push(`pause ${id}`),
    resume: (id: string) => void calls.push(`resume ${id}`),
    remove: (id: string) => {
      const e = entries.get(id)!
      entries.delete(id)
      observer?.erased(e)
    },
    removeFile: async (id: string) => void calls.push(`removeFile ${id}`),
    open: (id: string) => void calls.push(`open ${id}`),
    reveal: (id: string) => void calls.push(`reveal ${id}`),
    openFolder: () => void calls.push('openFolder'),
    fileIcon: async () => 'data:image/png;base64,AA=='
  }
  const change = (id: string, patch: Partial<DownloadState>, extra: Partial<DownloadEntry> = {}) => {
    const e = entries.get(id)!
    Object.assign(e.state, patch)
    Object.assign(e, extra)
    observer?.changed(e)
  }
  return { manager: manager as unknown as DownloadManager, entries, calls, change }
}

function api(permissions = ['downloads']) {
  const fake = fakeManager()
  const events: Array<{ name: string; payload: unknown; wake: string | null; ids: string[] }> = []
  const downloads = new ExtensionDownloads({} as Session, fake.manager, {
    extension: (id) => (id === EXT ? { name: 'Tampermonkey', permissions } : null),
    listeners: () => (permissions.includes('downloads') ? [EXT] : []),
    emit: (ids, name, payload, wake) => void events.push({ ids, name, payload, wake }),
    exists: () => true
  })
  return { ...fake, downloads, events }
}

describe('ExtensionDownloads', () => {
  it('needs the downloads permission', async () => {
    const { downloads } = api([])
    await expect(downloads.call(EXT, 'search', [{}])).rejects.toThrow('"downloads" permission')
  })

  it('downloads, reports the start and how it ends (GM_download in browser API mode)', async () => {
    const { downloads, events, change } = api()
    const id = await downloads.call(EXT, 'download', [{ url: 'https://pbs.twimg.com/media/x.jpg:orig', filename: 'twitter/x.jpg' }])
    expect(id).toBe(1)
    expect(events[0]).toMatchObject({ name: 'onCreated', payload: { id: 1, state: 'in_progress', byExtensionId: EXT } })

    // Progress alone sends nothing; the end does, and wakes the extension that started it.
    change('d1', { receivedBytes: 60 })
    expect(events).toHaveLength(1)
    change('d1', { status: 'completed', receivedBytes: 100, endedAt: Date.now() })
    expect(events[1]).toMatchObject({ name: 'onChanged', wake: EXT, payload: { id: 1, state: { previous: 'in_progress', current: 'complete' } } })

    // Tampermonkey polls search({ id }) every second.
    expect(await downloads.call(EXT, 'search', [{ id: 1 }])).toMatchObject([{ id: 1, state: 'complete', exists: true }])
  })

  it('reads data from the calling context for data: and blob: URLs', async () => {
    const { downloads } = api()
    await expect(downloads.call(EXT, 'download', [{ url: 'data:text/plain,hi' }])).rejects.toThrow('Invalid URL')
    const id = await downloads.call(EXT, 'downloadData', [{ url: 'blob:chrome-extension://x/1', filename: 'a.txt' }, new Uint8Array([1, 2]), 'text/plain'])
    expect(await downloads.call(EXT, 'search', [{ id }])).toMatchObject([{ totalBytes: 2 }])
  })

  it('pauses, resumes and cancels by id, with Chrome errors', async () => {
    const { downloads, calls, change } = api()
    await downloads.call(EXT, 'download', [{ url: 'https://a.test/big.zip' }])
    await downloads.call(EXT, 'pause', [1])
    await expect(downloads.call(EXT, 'resume', [1])).rejects.toThrow('Download must be resumable')
    change('d1', { paused: true }, { canResume: true })
    await downloads.call(EXT, 'resume', [1])
    await downloads.call(EXT, 'cancel', [1])
    expect(calls).toEqual(['pause d1', 'resume d1', 'cancel d1'])
    await expect(downloads.call(EXT, 'pause', [99])).rejects.toThrow('Invalid download id')
    change('d1', { status: 'cancelled' }, { error: 'USER_CANCELED' })
    await expect(downloads.call(EXT, 'pause', [1])).rejects.toThrow('Download must be in progress')
    // Canceling what already ended is fine.
    await downloads.call(EXT, 'cancel', [1])
    expect(calls).toHaveLength(3)
  })

  it('erases finished downloads only, and says which', async () => {
    const { downloads, events, change } = api()
    await downloads.call(EXT, 'download', [{ url: 'https://a.test/1' }])
    await downloads.call(EXT, 'download', [{ url: 'https://a.test/2' }])
    change('d1', { status: 'completed' })
    expect(await downloads.call(EXT, 'erase', [{}])).toEqual([1])
    expect(events.at(-1)).toMatchObject({ name: 'onErased', payload: 1 })
    expect(await downloads.call(EXT, 'search', [{}])).toMatchObject([{ id: 2 }])
  })

  it('opens files only with downloads.open', async () => {
    const { downloads, change, calls } = api()
    await downloads.call(EXT, 'download', [{ url: 'https://a.test/1' }])
    change('d1', { status: 'completed' })
    await expect(downloads.call(EXT, 'open', [1])).rejects.toThrow('"downloads.open" permission')
    const withOpen = api(['downloads', 'downloads.open'])
    await withOpen.downloads.call(EXT, 'download', [{ url: 'https://a.test/1' }])
    withOpen.change('d1', { status: 'completed' })
    await withOpen.downloads.call(EXT, 'open', [1])
    expect(withOpen.calls).toEqual(['open d1'])
    expect(calls).toEqual([])
  })
})
