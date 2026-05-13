import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { PtyManager } from './pty'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    backgroundColor: '#1a1b26',
    title: 'Tau Terminal',
    show: false, // Hide until terminal is ready (instant-open feel)
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
      enableWebSQL: false,
    },
  })

  // Show window only when the renderer signals it's ready
  ipcMain.once('renderer:ready', () => {
    mainWindow?.show()
  })

  // Remove the menu bar for a cleaner look
  mainWindow.setMenuBarVisibility(false)

  // Load the renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    // Open DevTools in dev mode
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// --- PTY Setup ---

let ptyManager: PtyManager | null = null

function setupPty() {
  if (!mainWindow) return

  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  console.log(`[main] Spawning PTY with shell: ${shell}`)

  try {
    ptyManager = new PtyManager(shell)

    // PTY output → renderer
    ptyManager.onData((data: string) => {
      mainWindow?.webContents.send('pty:data', data)
    })

    // Handle pty exit
    ptyManager.onExit(({ exitCode, signal }) => {
      console.log(`[main] PTY exited with code ${exitCode}, signal ${signal}`)
      ptyManager = null
      // Notify renderer that PTY exited
      mainWindow?.webContents.send('pty:exit', { exitCode, signal })
    })
  } catch (err) {
    console.error('[main] Failed to spawn PTY:', err)
    mainWindow?.webContents.send('pty:error', String(err))
  }
}

// --- IPC Handlers ---

ipcMain.on('pty:write', (_event, data: string) => {
  ptyManager?.write(data)
})

ipcMain.on('pty:resize', (_event, cols: number, rows: number) => {
  ptyManager?.resize(cols, rows)
})

ipcMain.handle('pty:getInitialColsRows', () => {
  return ptyManager?.getColsRows() ?? { cols: 80, rows: 24 }
})

// --- App Lifecycle ---

app.whenReady().then(() => {
  createWindow()
  setupPty()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      setupPty()
    }
  })
})

app.on('window-all-closed', () => {
  ptyManager?.dispose()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  ptyManager?.dispose()
})
