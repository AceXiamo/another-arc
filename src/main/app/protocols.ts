import { net, protocol, session, type Session } from 'electron'
import { extname, join, normalize, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FaviconCache } from '../history/favicon-cache'
import { outPath } from './environment'

export const SHELL_SCHEME = 'app'
export const SHELL_HOST = 'shell'
export const SHELL_ORIGIN = `${SHELL_SCHEME}://${SHELL_HOST}`
export const FAVICON_SCHEME = 'favicon'
/** Download thumbnails: `thumb://download/<id>?v=<endedAt>`. */
export const THUMB_SCHEME = 'thumb'

/** Must run before `app.whenReady()`. Electron allows a single call. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SHELL_SCHEME,
      // `codeCache` keeps compiled shell JS between launches (faster boot);
      // it requires a standard scheme.
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
    },
    { scheme: FAVICON_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: THUMB_SCHEME, privileges: { standard: true, secure: true } },
    // Registered on behalf of electron-chrome-extensions, which is imported
    // lazily after `ready` and therefore cannot register it itself. `secure`
    // matters: the shell is a secure context (app://) and would otherwise
    // block extension action icons as mixed content; non-standard schemes
    // cannot be used for subresources at all.
    { scheme: 'crx', privileges: { standard: true, secure: true, bypassCSP: true } }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${FAVICON_SCHEME}: ${THUMB_SCHEME}: crx:`,
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'"
].join('; ')

/**
 * Serves the built shell from `out/renderer`, cached favicons, download
 * thumbnails and extension action icons. All must be registered before the
 * shell loads: Chromium binds custom-scheme loaders when a frame is created,
 * so a handler added later (e.g. by the lazily imported extensions library)
 * never reaches it.
 * A favicon missing from the cache (a history page's site icon) is fetched
 * once through `iconSession`; the shell itself never touches the network.
 */
export function handleAppProtocols(
  favicons: FaviconCache,
  extensionIcon: (request: Request) => Response | Promise<Response>,
  iconSession: () => Session,
  downloadThumbnail: (id: string) => Promise<Buffer | null>
): void {
  const root = outPath('renderer')
  const ses = session.defaultSession

  ses.protocol.handle(SHELL_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== SHELL_HOST) return new Response('Not found', { status: 404 })
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = normalize(join(root, pathname))
    const rel = relative(root, file)
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      return new Response('Forbidden', { status: 403 })
    }
    const res = await net.fetch(pathToFileURL(file).toString())
    if (!res.ok) return res
    const headers = new Headers({
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff'
    })
    if (extname(file) === '.html') headers.set('content-security-policy', SHELL_CSP)
    return new Response(res.body, { status: 200, headers })
  })

  ses.protocol.handle('crx', extensionIcon)

  ses.protocol.handle(THUMB_SCHEME, async (request) => {
    const url = new URL(request.url)
    const png = url.host === 'download' ? await downloadThumbnail(decodeURIComponent(url.pathname.slice(1))) : null
    if (!png) return new Response(null, { status: 404 })
    // `v` changes when the file does, so a URL never goes stale.
    return new Response(new Uint8Array(png), {
      headers: { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' }
    })
  })

  ses.protocol.handle(FAVICON_SCHEME, async (request) => {
    const target = new URL(request.url).searchParams.get('u')
    if (!target) return new Response(null, { status: 404 })
    let icon = favicons.get(target)
    if (!icon && (await favicons.ensure(target, iconSession()))) icon = favicons.get(target)
    if (!icon) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(icon.data), {
      headers: {
        'content-type': icon.mime,
        'cache-control': 'max-age=31536000, immutable',
        // SVG favicons must never run script inside the shell.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
      }
    })
  })
}

export function shellUrl(devUrl: string | null): string {
  return devUrl ?? `${SHELL_ORIGIN}/index.html`
}
