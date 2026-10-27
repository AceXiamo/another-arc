import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILES_DIR, globToRegExpSource, guardWithGlobs, NATIVE_PREFIX, UserScriptStore } from '../../src/main/extensions/user-scripts'

const ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo'
const dirs: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'arc-us-'))
  dirs.push(root)
  const install = join(root, 'install')
  mkdirSync(install)
  writeFileSync(join(install, 'content.js'), 'console.log("content")')
  const store = new UserScriptStore(join(root, 'registry'), (id) => (id === ID ? install : null))
  return { store, install, root }
}

async function register(store: UserScriptStore, scripts: unknown[]) {
  const { token, native } = await store.prepare(ID, 'register', scripts)
  await store.commit(ID, token)
  return native
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('UserScriptStore', () => {
  it('registers, lists with code, and refuses duplicates', async () => {
    const { store, install } = setup()
    const native = await register(store, [{ id: 'a', matches: ['https://example.com/*'], world: 'MAIN', js: [{ code: 'window.a = 1' }] }])
    expect(native).toEqual([
      expect.objectContaining({ id: `${NATIVE_PREFIX}a`, world: 'MAIN', runAt: 'document_idle', allFrames: false, excludeMatches: [] })
    ])
    // MAIN world code is written as is.
    expect(readFileSync(join(install, native[0]!.js[0]!), 'utf8')).toBe('window.a = 1')
    expect(await store.get(ID, null)).toEqual([
      { id: 'a', matches: ['https://example.com/*'], js: [{ code: 'window.a = 1' }], allFrames: false, runAt: 'document_idle', world: 'MAIN' }
    ])
    await expect(store.prepare(ID, 'register', [{ id: 'a', matches: ['<all_urls>'], js: [{ code: '' }] }])).rejects.toThrow("Duplicate script ID 'a'")
  })

  it('validates like Chrome', async () => {
    const { store } = setup()
    const bad = (s: unknown) => store.prepare(ID, 'register', [s])
    await expect(bad({ id: '', matches: ['<all_urls>'], js: [{ code: '' }] })).rejects.toThrow('must not be empty')
    await expect(bad({ id: '_x', matches: ['<all_urls>'], js: [{ code: '' }] })).rejects.toThrow("must not start with '_'")
    await expect(bad({ id: 'x', js: [{ code: '' }] })).rejects.toThrow("must specify 'matches'")
    await expect(bad({ id: 'x', matches: ['<all_urls>'] })).rejects.toThrow('at least one js source')
    await expect(bad({ id: 'x', matches: ['<all_urls>'], js: [{ code: 'a', file: 'b.js' }] })).rejects.toThrow("exactly one of 'code' or 'file'")
    await expect(bad({ id: 'x', matches: ['not a pattern'], js: [{ code: '' }] })).rejects.toThrow('invalid match pattern')
    await expect(bad({ id: 'x', matches: ['<all_urls>'], js: [{ file: '../outside.js' }] })).rejects.toThrow('Could not load file')
    await expect(store.prepare(ID, 'update', [{ id: 'nope', js: [{ code: '' }] }])).rejects.toThrow('does not exist')
    await expect(store.unregister(ID, { ids: ['nope'] })).rejects.toThrow("Nonexistent script ID 'nope'")
  })

  it('wraps USER_SCRIPT world code for the bridge, and lists the bridge first', async () => {
    const { store, install } = setup()
    await store.configureWorld(ID, { csp: "script-src 'unsafe-eval'", messaging: true })
    await register(store, [{ id: 'u', matches: ['<all_urls>'], js: [{ code: 'var x = 1' }, { file: 'content.js' }] }])
    const native = await store.native(ID)
    expect(native.map((n) => n.id)).toEqual([`${NATIVE_PREFIX}_bridge`, `${NATIVE_PREFIX}u`])
    expect(native[0]).toMatchObject({ runAt: 'document_start', allFrames: true, matches: ['<all_urls>'], world: 'ISOLATED' })
    const file = readFileSync(join(install, native[1]!.js[0]!), 'utf8')
    expect(file).toContain(`globalThis.__arcUSB("", ${JSON.stringify('var x = 1')})`)
    expect(file).toContain('"messaging":true')
    // A {file} source in that world is wrapped too, so it is a generated file.
    expect(native[1]!.js[1]).toMatch(new RegExp(`^${FILES_DIR}/`))
    expect(readFileSync(join(install, native[1]!.js[1]!), 'utf8')).toContain('console.log(\\"content\\")')
  })

  it('rewrites the files when the world properties change', async () => {
    const { store } = setup()
    await register(store, [{ id: 'u', matches: ['<all_urls>'], js: [{ code: 'var x = 1' }] }])
    const before = (await store.native(ID))[1]!.js
    await store.configureWorld(ID, { csp: "script-src 'unsafe-eval'" })
    const after = (await store.native(ID))[1]!.js
    expect(after).not.toEqual(before)
    await store.resetWorld(ID, null)
    expect((await store.native(ID))[1]!.js).toEqual(before)
  })

  it('updates in place, and puts files back after the installed copy is replaced', async () => {
    const { store, install } = setup()
    await register(store, [{ id: 'm', matches: ['<all_urls>'], world: 'MAIN', js: [{ code: 'one' }] }])
    const { token, native } = await store.prepare(ID, 'update', [{ id: 'm', js: [{ code: 'two' }], runAt: 'document_start' }])
    expect(native[0]).toMatchObject({ runAt: 'document_start', matches: ['<all_urls>'] })
    // Not applied before the commit.
    expect((await store.get(ID, null))[0]!.js).toEqual([{ code: 'one' }])
    await store.commit(ID, token)
    expect((await store.get(ID, null))[0]).toMatchObject({ js: [{ code: 'two' }], runAt: 'document_start' })
    // An update of the extension replaces its folder.
    rmSync(join(install, FILES_DIR), { recursive: true, force: true })
    const [m] = await store.native(ID)
    expect(readFileSync(join(install, m!.js[0]!), 'utf8')).toBe('two')
  })

  it('persists across instances, and forgets on uninstall', async () => {
    const { store, root, install } = setup()
    await register(store, [{ id: 'm', matches: ['<all_urls>'], world: 'MAIN', js: [{ code: 'kept' }] }])
    store.flushSync()
    const again = new UserScriptStore(join(root, 'registry'), () => install)
    expect((await again.get(ID, { ids: ['m'] }))[0]!.js).toEqual([{ code: 'kept' }])
    await again.forget(ID)
    expect(await again.count(ID)).toBe(0)
    expect(readdirSync(join(root, 'registry'))).toEqual([])
  })

  it('unregisters by id or all', async () => {
    const { store } = setup()
    await register(store, [
      { id: 'a', matches: ['<all_urls>'], world: 'MAIN', js: [{ code: 'a' }] },
      { id: 'b', matches: ['<all_urls>'], world: 'MAIN', js: [{ code: 'b' }] }
    ])
    expect(await store.unregister(ID, { ids: ['a'] })).toEqual(['a'])
    expect(await store.unregister(ID, undefined)).toEqual(['b'])
    expect(await store.count(ID)).toBe(0)
  })
})

describe('globs', () => {
  it('matches Chrome globs against the whole URL', () => {
    const re = (g: string) => new RegExp(globToRegExpSource(g))
    expect(re('*://example.com/*').test('https://example.com/a')).toBe(true)
    expect(re('https://example.com/?').test('https://example.com/a')).toBe(true)
    expect(re('https://example.com/?').test('https://example.com/ab')).toBe(false)
    expect(re('*.png').test('https://x/a.png?q')).toBe(false)
    expect(re('https://a.b/(x)+').test('https://a.b/(x)+')).toBe(true)
  })

  it('runs the code only where the globs pass, keeping top-level vars global', () => {
    const code = guardWithGlobs('var hit = true', ['*/yes*'], ['*nope*'])
    const run = (href: string) => new Function('location', `${code}; return typeof hit !== 'undefined'`)({ href })
    expect(run('https://x/yes')).toBe(true)
    expect(run('https://x/yes-nope')).toBe(false)
    expect(run('https://x/other')).toBe(false)
  })
})
