import { ipcRenderer } from 'electron'
import {
  PASSWORD_IPC,
  type AutofillKey,
  type AutofillRequest,
  type AutofillState,
  type BlurInfo,
  type FieldRect,
  type SubmittedLogin
} from '@shared/passwords'
// prompt() support, which Electron removes from pages (see the file).
import './page-prompt'
// chrome.webstorePrivate on the Chrome Web Store, so its install button works.
import './web-store'
// The USER_SCRIPT world of chrome.userScripts (Tampermonkey & co).
import './user-script-world'
// Per-site switches that must act before the page's scripts run.
import './site-settings'

// Runs in every page, so it does as close to nothing as possible until a
// sign-in field is touched: a handful of capturing listeners, no polling, no
// DOM walk on load.
//
// The dropdown opens on what the user does — a click into a sign-in field,
// Tab into one, ↓ in one — and never on what the page or the browser does:
// a script calling `focus()`, the window getting focus back, or this file
// focusing the password field after a fill. Reacting to every `focusin`
// made those reopen the dropdown, and a dropdown that reopened whenever the
// page regained focus fought with anything that took it.
//
// It talks only to main. The page's own scripts cannot reach it (sandboxed,
// context-isolated, nothing on `window`). Keys it acts on must be real
// (`isTrusted`), so a page cannot pick a login by synthesizing ↓ and Enter.
// A password only ever travels main → here → the field's `value`.

const PASSWORD = 'input[type="password"]'
/** Field types a username can live in. */
const USERNAME_TYPES = new Set(['text', 'email', 'tel', ''])
/**
 * Autocomplete hints that mark a field as the username of a sign-in: the
 * field name, after any section or contact tokens and before `webauthn`.
 */
const USERNAME_HINTS = /(?:^|\s)(?:username|email|tel|new-username)(?:\s+webauthn)?\s*$/i

/** The sign-in field the dropdown belongs to. */
let field: HTMLInputElement | null = null
/** What main last said about the dropdown. */
let state: AutofillState = { open: false, active: -1 }
/** Set by a real click or Tab, and spent by the `focusin` that follows. */
let intent = false
let lastSubmitted: SubmittedLogin | null = null

function isPassword(node: unknown): node is HTMLInputElement {
  return node instanceof HTMLInputElement && node.type === 'password'
}

function isUsername(node: unknown): node is HTMLInputElement {
  if (!(node instanceof HTMLInputElement)) return false
  if (USERNAME_HINTS.test(node.autocomplete)) return true
  if (!USERNAME_TYPES.has(node.type)) return false
  // Only the field the password pairs with, as other browsers do: a captcha
  // or a code box in the same form is a text field too.
  const password = passwordNear(node)
  return password !== null && usernameBefore(password) === node
}

function isLoginField(node: unknown): node is HTMLInputElement {
  return isPassword(node) || isUsername(node)
}

/** The password field a username field belongs to: same form, or nearby. */
function passwordNear(input: HTMLInputElement): HTMLInputElement | null {
  if (input.form) return input.form.querySelector<HTMLInputElement>(PASSWORD)
  // Formless sign-ins: the nearest password field in the same subtree.
  let scope: Element | null = input.parentElement
  for (let depth = 0; scope && depth < 5; depth += 1) {
    const found = scope.querySelector<HTMLInputElement>(PASSWORD)
    if (found) return found
    scope = scope.parentElement
  }
  return null
}

/** The username field that goes with a password field, if there is one. */
function usernameBefore(password: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? document
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input')]
  // The username is the editable text field directly before the password,
  // past any the user cannot see (honeypots and the like).
  for (let i = inputs.indexOf(password) - 1; i >= 0; i -= 1) {
    const candidate = inputs[i]!
    if (candidate.disabled || candidate.readOnly || !USERNAME_TYPES.has(candidate.type)) continue
    if (candidate.checkVisibility()) return candidate
  }
  return null
}

function rectOf(input: Element): FieldRect {
  const box = input.getBoundingClientRect()
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

/** Ask main for the dropdown over `input`. */
function open(input: HTMLInputElement): void {
  field = input
  const typed = input.type === 'password' ? (usernameBefore(input)?.value ?? '') : input.value
  const request: AutofillRequest = { origin: location.origin, rect: rectOf(input), typed }
  ipcRenderer.send(PASSWORD_IPC.focus, request)
}

function blur(left: boolean): void {
  ipcRenderer.send(PASSWORD_IPC.blur, { left } satisfies BlurInfo)
}

function markIntent(): void {
  intent = true
  // Spent by the focusin this gesture causes, or gone by the next task.
  setTimeout(() => {
    intent = false
  }, 0)
}

// A real press anywhere: if it lands in a sign-in field, that focus is the
// user's. A press on a field that is already focused reopens the dropdown
// (after Escape, or after it closed on scroll).
document.addEventListener(
  'mousedown',
  (event) => {
    if (!event.isTrusted || event.button !== 0) return
    const target = event.target
    if (isLoginField(target) && target === document.activeElement) {
      if (!state.open) open(target)
      return
    }
    markIntent()
  },
  true
)

document.addEventListener(
  'focusin',
  (event) => {
    const target = event.target
    if (!isLoginField(target)) return
    field = target
    if (intent) {
      intent = false
      open(target)
    }
  },
  true
)

document.addEventListener(
  'focusout',
  (event) => {
    if (event.target !== field) return
    // Decide once focus has settled: moved on inside the page, or left it.
    setTimeout(() => {
      if (!document.hasFocus()) {
        if (state.open) blur(true)
        return
      }
      if (!isLoginField(document.activeElement)) {
        field = null
        if (state.open) blur(false)
      }
    }, 0)
  },
  true
)

document.addEventListener(
  'keydown',
  (event) => {
    if (!event.isTrusted) return
    if (event.key === 'Tab') {
      // The field Tab lands on gets focus as a result of this key.
      markIntent()
      return
    }
    if (event.target !== field || !field || event.isComposing) return
    if (!state.open) {
      if (event.key === 'ArrowDown' && !event.altKey && !event.metaKey) {
        event.preventDefault()
        open(field)
      }
      return
    }
    const key = keyFor(event)
    if (key === 'escape') {
      event.preventDefault()
      blur(false)
      return
    }
    // Enter only belongs to the dropdown when a row is picked; otherwise the
    // form submits as it always would.
    if (key === null || (key === 'enter' && state.active < 0)) return
    event.preventDefault()
    event.stopPropagation()
    ipcRenderer.send(PASSWORD_IPC.key, key satisfies AutofillKey)
  },
  true
)

function keyFor(event: KeyboardEvent): AutofillKey | 'escape' | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  switch (event.key) {
    case 'ArrowDown':
      return 'down'
    case 'ArrowUp':
      return 'up'
    case 'Enter':
      return 'enter'
    case 'Escape':
      return 'escape'
    default:
      return null
  }
}

// Typing a username narrows the list; typing a password means the user is
// not picking one, so the dropdown gets out of the way.
document.addEventListener(
  'input',
  (event) => {
    if (event.target !== field || !field || !state.open) return
    if (field.type === 'password') blur(false)
    else open(field)
  },
  true
)

// The dropdown is pinned to the field, so it follows the field when the page
// scrolls or resizes, once per frame, and closes when the field scrolls out
// of sight. Focusing a field often scrolls it into view; closing on every
// scroll would close the dropdown the moment it opened.
let moveQueued = false
function follow(): void {
  if (!field || !state.open || moveQueued) return
  moveQueued = true
  requestAnimationFrame(() => {
    moveQueued = false
    if (!field || !state.open) return
    const rect = rectOf(field)
    const hidden = rect.y + rect.height < 0 || rect.y > innerHeight || rect.x + rect.width < 0 || rect.x > innerWidth
    if (hidden) blur(false)
    else ipcRenderer.send(PASSWORD_IPC.move, rect)
  })
}
addEventListener('scroll', follow, { capture: true, passive: true })
addEventListener('resize', follow, { passive: true })

addEventListener(
  'pagehide',
  () => {
    flush()
    if (state.open) blur(false)
  },
  { capture: true }
)

ipcRenderer.on(PASSWORD_IPC.state, (_event, next: AutofillState) => {
  state = next
})

/**
 * Put a credential into the form. Values are set through the native setter
 * so React and friends see a real change rather than a silent assignment.
 * Focusing the password field afterwards is ours, not the user's, so it
 * opens nothing.
 */
ipcRenderer.on(PASSWORD_IPC.fill, (_event, username: string, password: string) => {
  const target = field ?? document.querySelector<HTMLInputElement>(PASSWORD)
  if (!target) return
  const onPassword = target.type === 'password'
  const passwordField = onPassword ? target : passwordNear(target)
  const usernameField = onPassword ? usernameBefore(target) : target
  if (usernameField && username) setValue(usernameField, username)
  if (passwordField) setValue(passwordField, password)
  passwordField?.focus()
})

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

// -- offering to save --------------------------------------------------------

/** A sign-in the user just made, remembered until the page goes away. */
function remember(password: HTMLInputElement): void {
  if (!password.value) return
  lastSubmitted = { origin: location.origin, username: usernameBefore(password)?.value ?? '', password: password.value }
}

function flush(): void {
  if (!lastSubmitted) return
  ipcRenderer.send(PASSWORD_IPC.submitted, lastSubmitted)
  lastSubmitted = null
}

document.addEventListener(
  'submit',
  (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement)) return
    const password = form.querySelector<HTMLInputElement>(PASSWORD)
    if (password) {
      remember(password)
      // A classic form navigates; a framework may not, so report either way
      // on the next tick rather than waiting for `pagehide`.
      setTimeout(flush, 0)
    }
  },
  true
)

// Sign-in buttons that never fire `submit` (most single-page apps).
document.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted) return
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button, input[type="submit"], [role="button"]')
    if (!button) return
    const scope: ParentNode = (button as HTMLButtonElement).form ?? document
    const password = scope.querySelector<HTMLInputElement>(PASSWORD)
    if (password?.value) {
      remember(password)
      // Give the app a moment to accept it; `pagehide` catches the rest.
      setTimeout(flush, 1000)
    }
  },
  true
)
