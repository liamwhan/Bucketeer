import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import type { BucketeerApi, MenuAction, UpdateCheckResult } from '@shared/api'

const REPO = 'liamwhan/Bucketeer'
const RELEASES_URL_PREFIX = `https://github.com/${REPO}/releases`

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i]
  }
  return false
}

/** Compares the running app version against the latest GitHub release. */
async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = await getVersion()
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status} while checking for updates.`)
  const release = (await res.json()) as { tag_name?: string; html_url?: string }

  const latest = parseVersion(release.tag_name ?? '')
  const current = parseVersion(currentVersion)
  if (!latest || !current) throw new Error('Could not parse release version.')

  const htmlUrl = release.html_url ?? ''
  return {
    currentVersion,
    latestVersion: latest.join('.'),
    updateAvailable: isNewer(latest, current),
    releaseUrl: htmlUrl.startsWith(RELEASES_URL_PREFIX) ? htmlUrl : RELEASES_URL_PREFIX
  }
}

/** Tauri rejects with the Rust error string; surface it as a normal Error. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
}

const api: BucketeerApi = {
  app: {
    getVersion,
    checkForUpdates,
    openReleasePage: (url) => call('app_open_release_page', { url }),
    onMenuAction: (callback) => {
      const unlisten = listen<MenuAction>('menu-action', (e) => callback(e.payload))
      return () => void unlisten.then((fn) => fn())
    }
  },
  accounts: {
    list: () => call('accounts_list'),
    add: (input) => call('accounts_add', { input }),
    update: (account) => call('accounts_update', { account }),
    remove: (id) => call('accounts_remove', { id })
  },
  s3: {
    listBuckets: (accountId) => call('s3_list_buckets', { accountId }),
    createBucket: (accountId, bucketName) => call('s3_create_bucket', { accountId, bucketName }),
    listObjects: (accountId, bucket, prefix) =>
      call('s3_list_objects', { accountId, bucket, prefix }),
    pickDownloadDir: () => call('s3_pick_download_dir'),
    downloadObjects: (accountId, bucket, keys, destDir) =>
      call('s3_download_objects', { accountId, bucket, keys, destDir }),
    renameObject: (accountId, bucket, sourceKey, newFileName) =>
      call('s3_rename_object', { accountId, bucket, sourceKey, newFileName }),
    createFolder: (accountId, bucket, prefix, folderName) =>
      call('s3_create_folder', { accountId, bucket, prefix, folderName }),
    uploadLocalFiles: (accountId, bucket, prefix, localPaths) =>
      call('s3_upload_local_files', { accountId, bucket, prefix, localPaths }),
    getObjectPreview: (accountId, bucket, key) =>
      call('s3_get_object_preview', { accountId, bucket, key }),
    putObjectText: (accountId, bucket, key, text, contentType) =>
      call('s3_put_object_text', { accountId, bucket, key, text, contentType })
  }
}

declare global {
  interface Window {
    bucketeer: BucketeerApi
  }
}

window.bucketeer = api

// Links with target=_blank would otherwise do nothing in the webview; send https/mailto to the system browser.
document.addEventListener('click', (e) => {
  const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  e.preventDefault()
  if (/^(https:|mailto:)/i.test(anchor.href)) void call('app_open_external', { url: anchor.href })
})
