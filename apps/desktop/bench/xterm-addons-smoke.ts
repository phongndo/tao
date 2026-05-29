import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

type SmokeResult = {
  name: string
  ok: boolean
  detail?: string
}

function packageFileUrl(packageName: string, relativePath: string): string {
  const root = dirname(require.resolve(`${packageName}/package.json`))
  return pathToFileURL(join(root, relativePath)).href
}

function rendererHtml(): string {
  const xtermCss = packageFileUrl('@xterm/xterm', 'css/xterm.css')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${xtermCss}" />
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #151515; }
      #terminal { width: 720px; height: 360px; padding: 8px; box-sizing: border-box; }
      .xterm { height: 100%; }
      .xterm-screen { position: relative; }
      .xterm-image-layer { position: absolute; inset: 0; pointer-events: none; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script>
      const { ipcRenderer } = require('electron')
      const { Terminal } = require('@xterm/xterm')
      const { ClipboardAddon } = require('@xterm/addon-clipboard')
      const { ImageAddon } = require('@xterm/addon-image')
      const { SearchAddon } = require('@xterm/addon-search')
      const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes')
      const { Unicode11Addon } = require('@xterm/addon-unicode11')
      const { WebLinksAddon } = require('@xterm/addon-web-links')

      const results = []

      function assert(name, condition, detail = '') {
        results.push({ name, ok: Boolean(condition), detail })
        if (!condition) throw new Error(name + (detail ? ': ' + detail : ''))
      }

      function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()))
      }

      function writeAndWait(term, data) {
        return new Promise((resolve) => term.write(data, resolve))
      }

      async function waitFor(predicate, timeoutMs, label) {
        const start = performance.now()
        while (performance.now() - start < timeoutMs) {
          if (predicate()) return true
          await nextFrame()
        }
        throw new Error('Timed out waiting for ' + label)
      }

      ;(async () => {
        const term = new Terminal({
          cols: 80,
          rows: 20,
          fontSize: 14,
          fontFamily: 'monospace',
          scrollback: 1000,
          allowProposedApi: true,
          logLevel: 'warn',
        })

        const container = document.getElementById('terminal')
        term.open(container)

        const unicode11Addon = new Unicode11Addon()
        term.loadAddon(unicode11Addon)
        term.unicode.activeVersion = '11'
        assert('unicode11 active version', term.unicode.activeVersion === '11', term.unicode.activeVersion)

        const graphemesAddon = new UnicodeGraphemesAddon()
        term.loadAddon(graphemesAddon)
        assert(
          'unicode graphemes active version',
          term.unicode.activeVersion === '15-graphemes',
          term.unicode.activeVersion,
        )

        const searchAddon = new SearchAddon({ highlightLimit: 1000 })
        term.loadAddon(searchAddon)
        await writeAndWait(term, 'alpha beta alpha\\r\\n')
        let searchEvent = null
        const searchEventDisposable = searchAddon.onDidChangeResults((event) => {
          searchEvent = event
        })
        assert(
          'search findNext',
          searchAddon.findNext('alpha', {
            decorations: {
              matchOverviewRuler: '#e6b99d',
              activeMatchColorOverviewRuler: '#ffae9f',
            },
          }),
        )
        await nextFrame()
        assert('search result count', searchEvent?.resultCount === 2, JSON.stringify(searchEvent))
        searchEventDisposable.dispose()

        const registeredLinkProviders = []
        const originalRegisterLinkProvider = term.registerLinkProvider.bind(term)
        term.registerLinkProvider = (provider) => {
          registeredLinkProviders.push(provider)
          return originalRegisterLinkProvider(provider)
        }
        let openedUri = ''
        term.loadAddon(new WebLinksAddon((_event, uri) => {
          openedUri = uri
        }))
        await writeAndWait(term, 'https://example.com/docs\\r\\n')
        const links = await new Promise((resolve) => {
          registeredLinkProviders[0].provideLinks(2, (value) => resolve(value ?? []))
        })
        assert('web links detected url', links.length > 0 && links[0].text === 'https://example.com/docs')
        links[0].activate(new MouseEvent('click'), links[0].text)
        assert('web links activate handler', openedUri === 'https://example.com/docs', openedUri)

        let clipboardText = ''
        const clipboardProvider = {
          readText: () => '',
          writeText: (_selection, text) => {
            clipboardText = text
          },
        }
        term.loadAddon(new ClipboardAddon(undefined, clipboardProvider))
        await writeAndWait(term, '\\x1b]52;c;Y2xpcGJvYXJkLXByb29m\\x07')
        assert('clipboard osc52 write', clipboardText === 'clipboard-proof', clipboardText)

        const imageAddon = new ImageAddon({ storageLimit: 8, pixelLimit: 4096 })
        term.loadAddon(imageAddon)
        await new Promise((resolve) => setTimeout(resolve, 500))
        const sixel = '\\x1bP0;0;0q#0;2;100;0;0#0@\\x1b\\\\'
        await writeAndWait(term, sixel)
        await waitFor(() => imageAddon.storageUsage > 0, 3000, 'sixel image storage')
        assert('image addon sixel storage', imageAddon.storageUsage > 0, String(imageAddon.storageUsage))
        imageAddon.reset()
        const gif1x1 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
        const iip = '\\x1b]1337;File=inline=1;width=1px;height=1px;size=' + atob(gif1x1).length + ':' + gif1x1 + '\\x07'
        await writeAndWait(term, iip)
        await waitFor(() => imageAddon.storageUsage > 0, 3000, 'image storage')
        term.refresh(0, term.rows - 1)
        await waitFor(() => document.querySelector('.xterm-image-layer') !== null, 3000, 'image layer')
        assert('image addon storage', imageAddon.storageUsage > 0, String(imageAddon.storageUsage))
        assert('image addon layer', document.querySelector('.xterm-image-layer') !== null)

        term.dispose()
        ipcRenderer.send('addons-smoke:done', results)
      })().catch((error) => {
        ipcRenderer.send('addons-smoke:error', String(error && error.stack ? error.stack : error))
      })
    </script>
  </body>
</html>`
}

function waitForResults(timeoutMs = 20_000): Promise<SmokeResult[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for xterm addon smoke results'))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      ipcMain.removeListener('addons-smoke:done', done)
      ipcMain.removeListener('addons-smoke:error', error)
    }

    const done = (_event: IpcMainEvent, results: SmokeResult[]) => {
      cleanup()
      resolve(results)
    }

    const error = (_event: IpcMainEvent, message: string) => {
      cleanup()
      reject(new Error(message))
    }

    ipcMain.once('addons-smoke:done', done)
    ipcMain.once('addons-smoke:error', error)
  })
}

function printResults(results: readonly SmokeResult[]): void {
  console.log('Tau xterm addon smoke')
  for (const result of results) {
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? ` (${result.detail})` : ''}`,
    )
  }
}

async function main(): Promise<void> {
  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 760,
    height: 400,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
      webgl: true,
    },
  })

  const resultPromise = waitForResults()
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`)
  const results = await resultPromise
  printResults(results)

  win.destroy()
  app.quit()
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
