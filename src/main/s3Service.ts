import { mkdir, createWriteStream, createReadStream } from 'fs'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  GetBucketLocationCommand,
  CreateBucketCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  type Bucket,
  type BucketLocationConstraint
} from '@aws-sdk/client-s3'
import type {
  AwsAccount,
  ListObjectsRow,
  DownloadResult,
  ObjectPreviewResult,
  UploadResult
} from '../shared/types.js'

const clientCache = new Map<string, S3Client>()
const bucketRegionCache = new Map<string, string>()

function clientFor(account: AwsAccount): S3Client {
  const cacheKey = `${account.id}:${account.region}:${account.accessKeyId}`
  let c = clientCache.get(cacheKey)
  if (!c) {
    c = new S3Client({
      region: account.region.trim(),
      credentials: {
        accessKeyId: account.accessKeyId.trim(),
        secretAccessKey: account.secretAccessKey
      }
    })
    clientCache.set(cacheKey, c)
  }
  return c
}

function clientForRegion(account: AwsAccount, region: string): S3Client {
  const normalizedRegion = region.trim()
  const cacheKey = `${account.id}:${normalizedRegion}:${account.accessKeyId}`
  let c = clientCache.get(cacheKey)
  if (!c) {
    c = new S3Client({
      region: normalizedRegion,
      credentials: {
        accessKeyId: account.accessKeyId.trim(),
        secretAccessKey: account.secretAccessKey
      }
    })
    clientCache.set(cacheKey, c)
  }
  return c
}

function normalizeBucketRegion(raw: string | null | undefined): string {
  if (!raw) return 'us-east-1'
  if (raw === 'EU') return 'eu-west-1'
  return raw
}

async function resolveBucketRegion(account: AwsAccount, bucket: string): Promise<string> {
  const cacheKey = `${account.id}:${bucket}`
  const cached = bucketRegionCache.get(cacheKey)
  if (cached) return cached

  const accountClient = clientFor(account)
  const result = await accountClient.send(new GetBucketLocationCommand({ Bucket: bucket }))
  const region = normalizeBucketRegion(result.LocationConstraint)
  bucketRegionCache.set(cacheKey, region)
  return region
}

async function clientForBucket(account: AwsAccount, bucket: string): Promise<S3Client> {
  const region = await resolveBucketRegion(account, bucket)
  return clientForRegion(account, region)
}

export function clearClientCache(accountId?: string): void {
  if (accountId) {
    for (const k of clientCache.keys()) {
      if (k.startsWith(`${accountId}:`)) {
        clientCache.delete(k)
      }
    }
    for (const k of bucketRegionCache.keys()) {
      if (k.startsWith(`${accountId}:`)) {
        bucketRegionCache.delete(k)
      }
    }
    return
  }
  clientCache.clear()
  bucketRegionCache.clear()
}

export async function listBucketsForAccount(account: AwsAccount): Promise<Bucket[]> {
  const client = clientFor(account)
  const out = await client.send(new ListBucketsCommand({}))
  return out.Buckets ?? []
}

/** CreateBucket: us-east-1 must omit LocationConstraint; all other regions require it. */
export async function createBucket(account: AwsAccount, bucketName: string): Promise<void> {
  const region = account.region.trim()
  const name = bucketName.trim()
  if (!name) {
    throw new Error('Bucket name is required')
  }
  const client = clientFor(account)
  if (region === 'us-east-1') {
    await client.send(new CreateBucketCommand({ Bucket: name }))
    return
  }
  await client.send(
    new CreateBucketCommand({
      Bucket: name,
      CreateBucketConfiguration: {
        LocationConstraint: region as BucketLocationConstraint
      }
    })
  )
}

function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

export async function listObjectsPage(
  account: AwsAccount,
  bucket: string,
  prefix: string
): Promise<{ rows: ListObjectsRow[]; isTruncated: boolean }> {
  const client = await clientForBucket(account, bucket)
  const rows: ListObjectsRow[] = []
  const seenFolders = new Set<string>()
  const seenFiles = new Set<string>()
  let continuationToken: string | undefined
  let isTruncated = false

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken
      })
    )

    for (const cp of res.CommonPrefixes ?? []) {
      const p = cp.Prefix ?? ''
      if (!p || seenFolders.has(p)) continue
      const base = stripTrailingSlash(p)
      const name = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base
      if (name) {
        rows.push({ type: 'folder', name, prefix: p })
        seenFolders.add(p)
      }
    }

    for (const obj of res.Contents ?? []) {
      const key = obj.Key ?? ''
      if (!key || key === prefix || seenFiles.has(key)) continue
      const relative = prefix ? key.slice(prefix.length) : key
      if (relative.includes('/')) continue
      const name = relative
      if (!name) continue
      rows.push({
        type: 'file',
        key,
        name,
        size: obj.Size,
        lastModified: obj.LastModified?.toISOString()
      })
      seenFiles.add(key)
    }

    isTruncated = Boolean(res.IsTruncated)
    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { rows, isTruncated }
}

async function ensureDirForFile(filePath: string): Promise<void> {
  const d = dirname(filePath)
  await mkdir(d, { recursive: true })
}

export async function downloadObjects(
  account: AwsAccount,
  bucket: string,
  keys: string[],
  destDir: string
): Promise<DownloadResult[]> {
  const client = await clientForBucket(account, bucket)
  const results: DownloadResult[] = []

  for (const key of keys) {
    const parts = key.split('/').filter(Boolean)
    const targetPath = join(destDir.replace(/[/\\]$/, ''), ...parts)
    try {
      await ensureDirForFile(targetPath)
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const body = res.Body
      if (!body) {
        throw new Error('Empty response body')
      }
      await pipeline(body as Readable, createWriteStream(targetPath))
      results.push({ key, ok: true, path: targetPath })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ key, ok: false, error: msg })
    }
  }

  return results
}

/** CopySource must be `bucket` + `/` + URL-encoded object key (slashes in key → %2F). */
function copySourceForKey(bucket: string, objectKey: string): string {
  return `${bucket}/${encodeURIComponent(objectKey)}`
}

/**
 * Rename = copy to new key in same "folder" (same parent prefix) then delete original.
 * Single-part copy only (objects larger than 5 GB need multipart copy — not supported here).
 */
export async function renameObject(
  account: AwsAccount,
  bucket: string,
  sourceKey: string,
  newFileName: string
): Promise<{ newKey: string }> {
  const segment = newFileName.trim()
  if (!segment) {
    throw new Error('New name is required')
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new Error('Object name cannot contain path separators')
  }

  const lastSlash = sourceKey.lastIndexOf('/')
  const parent = lastSlash === -1 ? '' : sourceKey.slice(0, lastSlash + 1)
  const newKey = `${parent}${segment}`

  if (newKey === sourceKey) {
    return { newKey }
  }

  const client = await clientForBucket(account, bucket)
  const copySource = copySourceForKey(bucket, sourceKey)

  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: newKey,
      CopySource: copySource
    })
  )

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: sourceKey
      })
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Object was copied to "${newKey}" but deleting the original failed: ${msg}`
    )
  }

  return { newKey }
}

/**
 * Folders in S3 are a UI convention: create an empty object whose key ends with `/`
 * so it appears under the current prefix when using delimiter `/`.
 */
export async function createFolder(
  account: AwsAccount,
  bucket: string,
  prefix: string,
  folderName: string
): Promise<{ key: string }> {
  const segment = folderName.trim().replace(/\/+$/, '')
  if (!segment) {
    throw new Error('Folder name is required')
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new Error('Folder name cannot contain path separators')
  }

  const normalizedPrefix =
    prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`
  const key = `${normalizedPrefix}${segment}/`

  const client = await clientForBucket(account, bucket)
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: new Uint8Array(0)
    })
  )
  return { key }
}

/**
 * Upload local files into the bucket under the current prefix (object key = prefix + basename).
 */
export async function uploadLocalFiles(
  account: AwsAccount,
  bucket: string,
  prefix: string,
  localPaths: string[]
): Promise<UploadResult[]> {
  const normalizedPrefix =
    prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`
  const client = await clientForBucket(account, bucket)
  const results: UploadResult[] = []

  for (const localPath of localPaths) {
    const name = basename(localPath)
    const key = `${normalizedPrefix}${name}`
    if (!name || name === '.' || name === '..') {
      results.push({ key, localPath, ok: false, error: 'Invalid file path' })
      continue
    }
    try {
      const st = await stat(localPath)
      if (!st.isFile()) {
        results.push({ key, localPath, ok: false, error: 'Not a file (folders are not uploaded)' })
        continue
      }
      const body = createReadStream(localPath)
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentLength: st.size
        })
      )
      results.push({ key, localPath, ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ key, localPath, ok: false, error: msg })
    }
  }

  return results
}

const PREVIEW_MAX_BYTES = 512 * 1024

function inferContentTypeFromKey(key: string): string {
  const lower = key.toLowerCase()
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

export async function getObjectPreview(
  account: AwsAccount,
  bucket: string,
  key: string
): Promise<ObjectPreviewResult> {
  const client = await clientForBucket(account, bucket)
  const tmpBase = await mkdtemp(join(tmpdir(), 'bucketeer-preview-'))
  const tempPath = join(tmpBase, basename(key) || 'preview.txt')

  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${PREVIEW_MAX_BYTES - 1}`
    })
  )
  const body = res.Body
  if (!body) {
    throw new Error('Empty response body')
  }

  await pipeline(body as Readable, createWriteStream(tempPath))
  const raw = await readFile(tempPath)
  const contentType = res.ContentType || inferContentTypeFromKey(key)
  const text = raw.toString('utf8')
  const contentRange = res.ContentRange ?? ''
  const totalMatch = /\/(\d+)$/.exec(contentRange)
  const totalBytes = totalMatch ? Number(totalMatch[1]) : Number.NaN
  const wasTruncated = Number.isFinite(totalBytes)
    ? totalBytes > PREVIEW_MAX_BYTES
    : raw.length >= PREVIEW_MAX_BYTES
  if (wasTruncated) {
    throw new Error(`Preview is limited to ${Math.round(PREVIEW_MAX_BYTES / 1024)} KB.`)
  }

  if (contentType.includes('application/json')) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2)
      await writeFile(tempPath, pretty, 'utf8')
      return {
        key,
        tempPath,
        contentType,
        text: pretty,
        wasTruncated
      }
    } catch {
      return {
        key,
        tempPath,
        contentType,
        text,
        wasTruncated
      }
    }
  }

  return {
    key,
    tempPath,
    contentType,
    text,
    wasTruncated
  }
}

export async function putObjectText(
  account: AwsAccount,
  bucket: string,
  key: string,
  text: string,
  contentType: string
): Promise<{ key: string; eTag: string | undefined }> {
  const client = await clientForBucket(account, bucket)
  const body = Buffer.from(text, 'utf8')
  const out = await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  )
  return { key, eTag: out.ETag }
}
