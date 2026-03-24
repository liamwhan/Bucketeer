import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join } from 'path'

function resolveWindowIcon(): string | undefined {
  const ext =
    process.platform === 'win32' ? 'ico' : process.platform === 'darwin' ? 'icns' : 'png'
  const file = `icon.${ext}`
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'app-icons', file)
    if (existsSync(packaged)) {
      return packaged
    }
  }
  const dev = join(app.getAppPath(), 'build', file)
  if (existsSync(dev)) {
    return dev
  }
  // Dev fallback: use the source artwork directly when build/icon.* doesn't exist yet.
  const sourcePng = join(app.getAppPath(), 'Bucketeer.png')
  if (existsSync(sourcePng)) {
    return sourcePng
  }
  return undefined
}
import * as accountsStore from './accountsStore.js'
import * as s3 from './s3Service.js'
import type { AwsAccount, UploadResult } from '../shared/types.js'

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:'])
const DEV_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1'])

function parseUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

function isSafeExternalUrl(raw: string): boolean {
  const url = parseUrl(raw)
  if (!url) return false
  return ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)
}

function isSafeRendererDevUrl(raw: string): boolean {
  const url = parseUrl(raw)
  if (!url) return false
  if (!['http:', 'https:'].includes(url.protocol)) return false
  return DEV_ALLOWED_HOSTS.has(url.hostname)
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${field} is required`)
  }
  return trimmed
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array`)
  }
  const out = value.map((item, idx) => assertString(item, `${field}[${idx}]`))
  if (out.length === 0) {
    throw new Error(`${field} must include at least one item`)
  }
  return out
}

async function assertExistingDirectory(pathValue: unknown, field: string): Promise<string> {
  const dir = assertString(pathValue, field)
  const dirStat = await stat(dir)
  if (!dirStat.isDirectory()) {
    throw new Error(`${field} must be a directory`)
  }
  return dir
}

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
  const icon = resolveWindowIcon()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Bucketeer',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: preloadScriptPath(),
      // Keep sandbox off for now: current preload output is ESM and fails to load when sandboxed.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    const loaded = win.webContents.getURL()
    if (!loaded) {
      event.preventDefault()
      return
    }
    const currentOrigin = parseUrl(loaded)?.origin
    const nextOrigin = parseUrl(navigationUrl)?.origin
    if (!currentOrigin || !nextOrigin || currentOrigin !== nextOrigin) {
      event.preventDefault()
    }
  })

  if (!process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame') {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: file:",
        "connect-src 'self' https://*.amazonaws.com https://s3.amazonaws.com",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'"
      ].join('; ')
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp]
        }
      })
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (!rendererUrl || !isSafeRendererDevUrl(rendererUrl)) {
      throw new Error('ELECTRON_RENDERER_URL must point to a local development origin')
    }
    win.loadURL(rendererUrl)
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
    return accountsStore.addAccount({
      label: assertString(input.label, 'label'),
      accessKeyId: assertString(input.accessKeyId, 'accessKeyId'),
      secretAccessKey: assertString(input.secretAccessKey, 'secretAccessKey'),
      region: assertString(input.region, 'region')
    })
  })

  ipcMain.handle('accounts:update', (_, account: AwsAccount) => {
    const nextAccount: AwsAccount = {
      id: assertString(account.id, 'id'),
      label: assertString(account.label, 'label'),
      accessKeyId: assertString(account.accessKeyId, 'accessKeyId'),
      secretAccessKey: assertString(account.secretAccessKey, 'secretAccessKey'),
      region: assertString(account.region, 'region')
    }
    accountsStore.updateAccount(nextAccount)
    s3.clearClientCache(nextAccount.id)
  })

  ipcMain.handle('accounts:remove', (_, id: string) => {
    const accountId = assertString(id, 'accountId')
    accountsStore.removeAccount(accountId)
    s3.clearClientCache(accountId)
  })

  ipcMain.handle('s3:listBuckets', async (_, accountId: string) => {
    const account = getAccountOrThrow(assertString(accountId, 'accountId'))
    return s3.listBucketsForAccount(account)
  })

  ipcMain.handle('s3:createBucket', async (_, accountId: string, bucketName: string) => {
    const account = getAccountOrThrow(assertString(accountId, 'accountId'))
    await s3.createBucket(account, assertString(bucketName, 'bucketName'))
  })

  ipcMain.handle(
    's3:listObjects',
    async (_, accountId: string, bucket: string, prefix: string) => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.listObjectsPage(
        account,
        assertString(bucket, 'bucket'),
        typeof prefix === 'string' ? prefix : ''
      )
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
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      const normalizedBucket = assertString(bucket, 'bucket')
      const normalizedKeys = assertStringArray(keys, 'keys')
      const normalizedDestDir = await assertExistingDirectory(destDir, 'destDir')
      return s3.downloadObjects(account, normalizedBucket, normalizedKeys, normalizedDestDir)
    }
  )

  ipcMain.handle(
    's3:renameObject',
    async (
      _,
      accountId: string,
      bucket: string,
      sourceKey: string,
      newFileName: string
    ): Promise<{ newKey: string }> => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.renameObject(
        account,
        assertString(bucket, 'bucket'),
        assertString(sourceKey, 'sourceKey'),
        assertString(newFileName, 'newFileName')
      )
    }
  )

  ipcMain.handle(
    's3:createFolder',
    async (
      _,
      accountId: string,
      bucket: string,
      prefix: string,
      folderName: string
    ): Promise<{ key: string }> => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.createFolder(
        account,
        assertString(bucket, 'bucket'),
        typeof prefix === 'string' ? prefix : '',
        assertString(folderName, 'folderName')
      )
    }
  )

  ipcMain.handle(
    's3:uploadLocalFiles',
    async (
      _,
      accountId: string,
      bucket: string,
      prefix: string,
      localPaths: string[]
    ): Promise<UploadResult[]> => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.uploadLocalFiles(
        account,
        assertString(bucket, 'bucket'),
        typeof prefix === 'string' ? prefix : '',
        assertStringArray(localPaths, 'localPaths')
      )
    }
  )

  ipcMain.handle(
    's3:getObjectPreview',
    async (_, accountId: string, bucket: string, key: string) => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.getObjectPreview(account, assertString(bucket, 'bucket'), assertString(key, 'key'))
    }
  )

  ipcMain.handle(
    's3:putObjectText',
    async (
      _,
      accountId: string,
      bucket: string,
      key: string,
      text: string,
      contentType: string
    ) => {
      const account = getAccountOrThrow(assertString(accountId, 'accountId'))
      return s3.putObjectText(
        account,
        assertString(bucket, 'bucket'),
        assertString(key, 'key'),
        typeof text === 'string' ? text : '',
        assertString(contentType, 'contentType')
      )
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
    void s3.cleanupPreviewCache()
    app.quit()
  }
})

app.on('before-quit', () => {
  void s3.cleanupPreviewCache()
})
