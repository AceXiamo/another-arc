import { clipboard, Menu, MenuItem, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { Translate } from '@shared/i18n'

export interface PageMenuActions {
  openUrl(url: string, background: boolean): void
  search(text: string): void
  extensionItems(): MenuItem[]
  searchEngineName: string
  t: Translate
}

function truncate(text: string, max = 24): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Native context menu for a web page — no DOM, no extra renderer work. */
export function showPageContextMenu(wc: WebContents, params: ContextMenuParams, actions: PageMenuActions): void {
  const items: MenuItemConstructorOptions[] = []
  const sep = () => {
    if (items.length && items[items.length - 1]!.type !== 'separator') items.push({ type: 'separator' })
  }
  const { editFlags } = params
  const { t } = actions

  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5)
    for (const s of suggestions) items.push({ label: s, click: () => wc.replaceMisspelling(s) })
    if (suggestions.length === 0) items.push({ label: t('ctx.noSuggestions'), enabled: false })
    items.push({
      label: t('ctx.addToDictionary'),
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
    })
    sep()
  }

  if (params.linkURL) {
    const link = params.linkURL
    items.push(
      { label: t('ctx.openLinkInNewTab'), click: () => actions.openUrl(link, false) },
      { label: t('ctx.openLinkInBackground'), click: () => actions.openUrl(link, true) },
      sepItem(),
      { label: t('ctx.copyLink'), click: () => clipboard.writeText(link) },
      { label: t('ctx.saveLinkAs'), click: () => wc.downloadURL(link) }
    )
    sep()
  }

  if (params.mediaType === 'image' && params.srcURL) {
    const src = params.srcURL
    items.push(
      { label: t('ctx.openImageInNewTab'), click: () => actions.openUrl(src, false) },
      { label: t('ctx.copyImage'), click: () => wc.copyImageAt(params.x, params.y) },
      { label: t('ctx.copyImageAddress'), click: () => clipboard.writeText(src) },
      { label: t('ctx.saveImageAs'), click: () => wc.downloadURL(src) }
    )
    sep()
  } else if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL) {
    const src = params.srcURL
    items.push(
      { label: t('ctx.openMediaInNewTab'), click: () => actions.openUrl(src, false) },
      { label: t('ctx.copyMediaAddress'), click: () => clipboard.writeText(src) },
      { label: t('ctx.saveMediaAs'), click: () => wc.downloadURL(src) }
    )
    sep()
  }

  if (params.isEditable) {
    items.push(
      { role: 'undo', label: t('menu.undo'), enabled: editFlags.canUndo },
      { role: 'redo', label: t('menu.redo'), enabled: editFlags.canRedo },
      sepItem(),
      { role: 'cut', label: t('menu.cut'), enabled: editFlags.canCut },
      { role: 'copy', label: t('menu.copy'), enabled: editFlags.canCopy },
      { role: 'paste', label: t('menu.paste'), enabled: editFlags.canPaste },
      { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle'), enabled: editFlags.canPaste },
      { role: 'selectAll', label: t('menu.selectAll'), enabled: editFlags.canSelectAll }
    )
    sep()
  } else if (params.selectionText.trim()) {
    const text = params.selectionText
    items.push(
      { role: 'copy', label: t('menu.copy') },
      { label: t('ctx.searchFor', { engine: actions.searchEngineName, text: truncate(text) }), click: () => actions.search(text) },
      { label: t('ctx.lookUp', { text: truncate(text, 16) }), click: () => wc.showDefinitionForSelection() }
    )
    sep()
  }

  if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
    const h = wc.navigationHistory
    items.push(
      { label: t('menu.back'), enabled: h.canGoBack(), click: () => h.goBack() },
      { label: t('menu.forward'), enabled: h.canGoForward(), click: () => h.goForward() },
      { label: t('common.reload'), click: () => wc.reload() }
    )
    sep()
  }

  const menu = Menu.buildFromTemplate(items)
  for (const item of actions.extensionItems()) menu.append(item)
  appendInspect(menu, wc, params, t)
  menu.popup({ frame: params.frame ?? undefined })
}

function sepItem(): MenuItemConstructorOptions {
  return { type: 'separator' }
}

function appendInspect(menu: Menu, wc: WebContents, params: ContextMenuParams, t: Translate): void {
  if (menu.items.length && menu.items[menu.items.length - 1]!.type !== 'separator') {
    menu.append(new MenuItem({ type: 'separator' }))
  }
  menu.append(
    new MenuItem({
      label: t('ctx.inspect'),
      click: () => {
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
        wc.inspectElement(params.x, params.y)
      }
    })
  )
}
