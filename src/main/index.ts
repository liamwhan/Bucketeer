import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import * as accountsStore from './accountsStore.js'
import * as s3 from './s3Service.js'
import type { AwsAccount } from '../shared/types.js'

function preloadScriptPath(): string {
  const dir = join(__dirname, '../preload')
  const candidates = ['index.js', 'index.mjs', 'index.cjs']
  for (const name of candidates) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, 'index.mjs')
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Bucketeer',
    webPreferences: {
      preload: preloadScriptPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function getAccountOrThrow(id: string): AwsAccount {
  const a = accountsStore.getAccount(id)
  if (!a) {
    throw new Error('Unknown account')
  }
  return a
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.bucketeer.app')
  }

  ipcMain.handle('accounts:list', () => accountsStore.listAccounts())

  ipcMain.handle('accounts:add', (_, input: Omit<AwsAccount, 'id'>) => {
    return accountsStore.addAccount(input)
  })

  ipcMain.handle('accounts:update', (_, account: AwsAccount) => {
    accountsStore.updateAccount(account)
    s3.clearClientCache(account.id)
  })

  ipcMain.handle('accounts:remove', (_, id: string) => {
    accountsStore.removeAccount(id)
    s3.clearClientCache(id)
  })

  ipcMain.handle('s3:listBuckets', async (_, accountId: string) => {
    const account = getAccountOrThrow(accountId)
    return s3.listBucketsForAccount(account)
  })

  ipcMain.handle(
    's3:listObjects',
    async (_, accountId: string, bucket: string, prefix: string) => {
      const account = getAccountOrThrow(accountId)
      return s3.listObjectsPage(account, bucket, prefix)
    }
  )

  ipcMain.handle('s3:pickDownloadDir', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return r.filePaths[0]
  })

  ipcMain.handle(
    's3:downloadObjects',
    async (_, accountId: string, bucket: string, keys: string[], destDir: string) => {
      const account = getAccountOrThrow(accountId)
      return s3.downloadObjects(account, bucket, keys, destDir)
    }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
