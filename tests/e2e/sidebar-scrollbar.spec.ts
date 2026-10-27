import { expect, test, type Page } from '@playwright/test'
import { launch, quit, removeDir, rpc, screenshot } from './helpers'

// The sidebar's scrollbar stays out of sight unless the list is moving or the
// pointer is at its edge — whatever the system "Show scroll bars" setting.

const SHOTS = process.env.ARC_SHOTS_DIR

const scroller = (shell: Page) => shell.locator('[data-sidebar-scroll]')

/** The thumb colour the stylesheet resolved, and the markers that drive it. */
const thumb = (shell: Page) =>
  scroller(shell).evaluate((el) => ({
    color: getComputedStyle(el).getPropertyValue('--scroll-thumb').trim(),
    scrolling: 'scrolling' in (el as HTMLElement).dataset,
    edge: 'scrollEdge' in (el as HTMLElement).dataset
  }))

const transparent = (color: string) => color === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(color) || color.endsWith(' 0)')

test('the sidebar scrollbar hides at rest, and shows while scrolling or at its edge', async () => {
  const { app, shell, userData } = await launch()
  try {
    for (let i = 0; i < 30; i++) await rpc(shell, 'tabs.create', { url: 'about:blank', background: true })
    await expect.poll(() => scroller(shell).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

    // At rest: nothing to see.
    await expect.poll(async () => transparent((await thumb(shell)).color)).toBe(true)
    if (SHOTS) await screenshot(app, `${SHOTS}/sidebar-rest.png`)

    // Scrolling: it fades in…
    await scroller(shell).evaluate((el) => el.scrollBy(0, 120))
    await expect.poll(() => thumb(shell)).toMatchObject({ scrolling: true })
    await expect.poll(async () => transparent((await thumb(shell)).color)).toBe(false)
    if (SHOTS) await screenshot(app, `${SHOTS}/sidebar-scrolling.png`)

    // …and goes again once the list settles.
    await expect.poll(() => thumb(shell), { timeout: 3000 }).toMatchObject({ scrolling: false })
    await expect.poll(async () => transparent((await thumb(shell)).color), { timeout: 3000 }).toBe(true)

    // Heading for the right edge shows it too, so it can be grabbed…
    const box = (await scroller(shell).boundingBox())!
    const at = (fromRight: number) => shell.mouse.move(box.x + box.width - fromRight, box.y + 40)
    await shell.mouse.move(box.x + box.width / 2, box.y + 40)
    expect((await thumb(shell)).edge).toBe(false)
    await at(16)
    await expect.poll(() => thumb(shell)).toMatchObject({ edge: true })
    await expect.poll(async () => transparent((await thumb(shell)).color)).toBe(false)
    // …and goes the moment the pointer heads back into the list.
    await shell.mouse.move(box.x + box.width / 2, box.y + 40)
    await expect.poll(() => thumb(shell)).toMatchObject({ edge: false })

    // Overshooting onto the resize handle (the outer 5px) leaves the list;
    // the thumb lingers a moment rather than vanishing under the pointer.
    await at(16)
    await expect.poll(() => thumb(shell)).toMatchObject({ edge: true })
    await at(2)
    expect((await thumb(shell)).edge).toBe(true)
    await expect.poll(() => thumb(shell), { timeout: 3000 }).toMatchObject({ edge: false })
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
