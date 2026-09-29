import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * The right-click menu for anything you type.
 *
 * Chromium checks spelling as you type but offers no menu of its own, so a
 * misspelling was underlined and then left there. This puts the usual one
 * back: the suggestions, a way to add a word, and cut, copy, paste, select
 * all. Nothing is ever corrected on its own — a suggestion is applied only
 * when picked — because a composer that rewrites what you meant is worse
 * than one that underlines it.
 *
 * Messages keep their own menu, built in the renderer; this one only speaks
 * for editable fields, and for a plain selection anywhere else.
 */
export function installEditingMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []

    if (params.isEditable) {
      if (params.misspelledWord) {
        const suggestions = params.dictionarySuggestions.slice(0, 5)
        if (suggestions.length === 0) {
          items.push({ label: 'No guesses found', enabled: false })
        }
        for (const word of suggestions) {
          items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) })
        }
        items.push({
          label: `Add “${params.misspelledWord}” to dictionary`,
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        })
        items.push({ type: 'separator' })
      }
      items.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      )
    } else if (params.selectionText.trim()) {
      // A selection in the transcript: the renderer's message menu has the
      // message; this has the words.
      items.push({ role: 'copy' })
    } else {
      return
    }

    Menu.buildFromTemplate(items).popup({ window: win })
  })
}
