import { app } from 'electron'

const REPO = 'liamwhan/Bucketeer'
export const RELEASES_URL_PREFIX = `https://github.com/${REPO}/releases`

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
}

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

/** Compares the running app version (from package.json) against the latest GitHub release. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `Bucketeer/${currentVersion}`
    },
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
