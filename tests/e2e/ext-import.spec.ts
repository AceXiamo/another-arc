import { expect, test } from '@playwright/test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { inMain, launch, quit, removeDir, ROOT, rpc, t, tempDir } from './helpers'

const PROBE = join(ROOT, 'tests/fixtures/extensions/api-probe')
const DISABLED_ID = 'c'.repeat(32)
const CRASHER_ID = 'nlipoenfbbikpbjkfpfillcgkoblgpmj'
const PROFILE_NAME = 'E2E Person'

/** Chromium's extension id for a manifest `key`: sha256 of the DER key, first 32 hex digits mapped 0-f → a-p. */
function idFromKey(der: Buffer): string {
  return [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
    .join('')
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

/** Copy of the API probe at `version`, with a `key`, laid out like a Web Store install. */
function addProbeVersion(root: string, id: string, key: string, version: string): void {
  const dir = join(root, 'Default', 'Extensions', id, `${version}_0`)
  cpSync(PROBE, dir, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(PROBE, 'manifest.json'), 'utf8'))
  writeJson(join(dir, 'manifest.json'), { ...manifest, version, key })
}

/** A fake Arc "User Data" folder: Local State, Preferences, Secure Preferences, Extensions/. */
function fakeArc(): { root: string; id: string } {
  const root = tempDir('arc-import-root-')
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const key = der.toString('base64')
  const id = idFromKey(der)
  writeJson(join(root, 'Local State'), {
    profile: { last_used: 'Default', info_cache: { Default: { name: PROFILE_NAME }, 'Profile 1': { name: 'Other' } } }
  })
  addProbeVersion(root, id, key, '0.9.0')
  addProbeVersion(root, id, key, '1.0.0')
  for (const [extId, name] of [
    [DISABLED_ID, 'Turned Off Ext'],
    [CRASHER_ID, 'Awesome Screen Recorder']
  ]) {
    writeJson(join(root, 'Default', 'Extensions', extId!, '1.0_0', 'manifest.json'), { manifest_version: 3, name, version: '1.0' })
  }
  mkdirSync(join(root, 'Default', 'Extensions', 'Temp'), { recursive: true })
  writeJson(join(root, 'Default', 'Preferences'), {
    extensions: { settings: { [DISABLED_ID]: { location: 1, disable_reasons: [1] } } }
  })
  writeJson(join(root, 'Default', 'Secure Preferences'), {
    extensions: {
      settings: {
        [id]: { location: 1, disable_reasons: [], path: `${id}/0.9.0_0` },
        [CRASHER_ID]: { location: 1, disable_reasons: [] },
        ['g'.repeat(32)]: { location: 5, path: '/Applications/Arc.app/Contents/Resources/pdf' }
      }
    }
  })
  return { root, id }
}

/** Every file under `dir` with size and mtime, to prove the import never writes there. */
function treeState(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const s = statSync(p)
        out.push(`${relative(dir, p)} ${s.size} ${s.mtimeMs}`)
      }
    }
  }
  walk(dir)
  return out.sort()
}

interface DialogCall {
  message: string
  detail: string
  buttons?: string[]
}

/** Replace dialog.showMessageBox in main with a recorder that answers `response`. */
async function stubDialogs(app: Parameters<typeof inMain>[0], response: number): Promise<void> {
  const ok = await inMain(
    app,
    (_b, answer: number, electron) => {
      const g = globalThis as { __dialogCalls?: unknown[]; __realShowMessageBox?: unknown }
      g.__dialogCalls = []
      g.__realShowMessageBox ??= electron.dialog.showMessageBox
      const stub = async (...args: unknown[]) => {
        const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string; buttons?: string[] }
        g.__dialogCalls!.push({ message: options.message, detail: options.detail, buttons: options.buttons })
        return { response: answer, checkboxChecked: false }
      }
      ;(stub as unknown as { __stub: boolean }).__stub = true
      electron.dialog.showMessageBox = stub as typeof electron.dialog.showMessageBox
      return (electron.dialog.showMessageBox as unknown as { __stub?: boolean }).__stub === true
    },
    response
  )
  // Never fall through to a real (blocking) dialog.
  expect(ok).toBe(true)
}

const dialogCalls = (app: Parameters<typeof inMain>[0]) =>
  inMain(app, () => (globalThis as { __dialogCalls?: DialogCall[] }).__dialogCalls ?? []) as Promise<DialogCall[]>

test('import extensions from an Arc profile, keeping ids and "Update from source"', async () => {
  test.setTimeout(120_000)
  const { root, id } = fakeArc()
  const userData = tempDir()
  const { app, shell } = await launch(userData, { ARC_IMPORT_ROOT: root })
  try {
    const before = treeState(root)

    // Detection: one source, the last-used profile, one importable extension.
    expect(await rpc(shell, 'extensions.importSources')).toEqual([
      { id: 'arc', browserName: 'Arc', profileName: PROFILE_NAME, importable: 1, total: 3 }
    ])
    const scan = await inMain(app, (b) => b.extensions.importSources())
    const skips = Object.fromEntries(scan[0].extensions.map((e: { id: string; skip: string | null }) => [e.id, e.skip]))
    expect(skips).toEqual({ [id]: null, [DISABLED_ID]: 'disabled', [CRASHER_ID]: 'incompatible' })
    expect(scan[0].extensions.find((e: { id: string }) => e.id === id).version).toBe('1.0.0')

    // The Extensions page offers the import next to "Load unpacked".
    await rpc(shell, 'tabs.openInternal', 'extensions')
    const button = shell.getByRole('button', { name: t('extImport.button', { browser: 'Arc' }) })
    await expect(button).toBeVisible()
    await expect(shell.getByRole('button', { name: t('extensions.page.load') })).toBeVisible()

    // Dialog flow, cancelled: the confirmation names the profile and lists skips.
    await stubDialogs(app, 1)
    await rpc(shell, 'extensions.importFromBrowser', 'arc')
    const [confirm] = await dialogCalls(app)
    expect(confirm!.message).toBe(t('extImport.confirm.message', { browser: 'Arc', profile: PROFILE_NAME }))
    expect(confirm!.detail).toContain('API Probe 1.0.0')
    expect(confirm!.detail).toContain(t('extImport.itemWithReason', { name: 'Turned Off Ext', reason: t('extImport.skip.disabled', { browser: 'Arc' }) }))
    expect(confirm!.detail).toContain(t('extImport.skip.crashes'))
    expect(await inMain(app, (b) => b.extensions.info().length)).toBe(0)

    // Dialog flow, accepted: imports and reports that data is not copied.
    await stubDialogs(app, 0)
    await rpc(shell, 'extensions.importFromBrowser', 'arc')
    const calls = await dialogCalls(app)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.message).toBe(t('extImport.result.done', { browser: 'Arc' }))
    expect(calls[1]!.detail).toContain(t('extImport.result.dataNote', { browser: 'Arc' }))
    expect((await inMain(app, (b) => b.extensions.info())).map((e: { id: string }) => e.id)).toEqual([id])
    await inMain(app, (b, extId: string) => b.extensions.uninstall(extId), id)

    // Dialog-free path (what tests and the flow above share).
    const outcome = await inMain(app, (b) => b.extensions.importFrom('arc'))
    expect(outcome.results).toEqual([{ id, sourceId: id, name: 'API Probe', version: '1.0.0', error: null }])
    const info = (await inMain(app, (b) => b.extensions.info())).find((e: { id: string }) => e.id === id)
    // Same id as in Arc (derived from the manifest key), source = Extensions/<id>.
    expect(info).toMatchObject({ id, version: '1.0.0', enabled: true, sourcePath: join(root, 'Default', 'Extensions', id) })
    expect(await inMain(app, (b, extId: string) => b.extensions['ses'].extensions.getExtension(extId)?.id ?? null, id)).toBe(id)
    await expect(shell.getByText('API Probe', { exact: true })).toBeVisible()

    // Now it is "already installed"; a second run has nothing new.
    expect((await rpc<Array<{ importable: number }>>(shell, 'extensions.importSources'))[0]!.importable).toBe(0)
    await stubDialogs(app, 0)
    await rpc(shell, 'extensions.importFromBrowser', 'arc')
    const [nothing] = await dialogCalls(app)
    expect(nothing!.message).toBe(t('extImport.nothing.message', { browser: 'Arc', profile: PROFILE_NAME }))

    // The import only read the Arc folder.
    expect(treeState(root)).toEqual(before)

    // Arc updates the extension: "Update from source" picks the newest version folder.
    const key = JSON.parse(readFileSync(join(root, 'Default', 'Extensions', id, '1.0.0_0', 'manifest.json'), 'utf8')).key
    addProbeVersion(root, id, key, '1.1.0')
    await inMain(app, (b, extId: string) => b.extensions.update(extId), id)
    const updated = (await inMain(app, (b) => b.extensions.info())).find((e: { id: string }) => e.id === id)
    expect(updated).toMatchObject({ id, version: '1.1.0', sourcePath: join(root, 'Default', 'Extensions', id) })
    expect(await inMain(app, (b, extId: string) => b.extensions['ses'].extensions.getExtension(extId)?.version ?? null, id)).toBe('1.1.0')
  } finally {
    await inMain(app, (_b, _a, electron) => {
      const g = globalThis as { __realShowMessageBox?: typeof electron.dialog.showMessageBox }
      if (g.__realShowMessageBox) electron.dialog.showMessageBox = g.__realShowMessageBox
    }).catch(() => undefined)
    await quit(app)
    removeDir(userData)
    removeDir(root)
  }
})
