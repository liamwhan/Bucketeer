import { createWriteStream, createReadStream } from 'fs'
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { Transform, type Readable } from 'stream'
import { createHash } from 'crypto'
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
const previewCleanupTimers = new Map<string, NodeJS.Timeout>()
const PREVIEW_TTL_MS = 15 * 60 * 1000

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

function assertSafeDownloadKey(key: string): string[] {
  const normalized = key.trim()
  if (!normalized) {
    throw new Error('Object key cannot be empty')
  }
  if (normalized.includes('\\')) {
    throw new Error(`Object key "${key}" contains unsupported path separators`)
  }

  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`Object key "${key}" does not map to a file path`)
  }

  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`Object key "${key}" contains path traversal segments`)
    }
    if (part.includes('\0')) {
      throw new Error(`Object key "${key}" contains invalid characters`)
    }
    if (isAbsolute(part) || /^[a-zA-Z]:/.test(part)) {
      throw new Error(`Object key "${key}" contains an absolute path segment`)
    }
  }
  return parts
}

function safeDownloadPath(destDir: string, key: string): string {
  const destBase = resolve(destDir)
  const parts = assertSafeDownloadKey(key)
  const targetPath = resolve(destBase, ...parts)
  const rel = relative(destBase, targetPath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Object key "${key}" resolves outside the destination folder`)
  }
  return targetPath
}

async function streamWithIntegrityChecks(
  body: Readable,
  targetPath: string,
  expectedSize?: number,
  expectedSha256Base64?: string
): Promise<void> {
  let bytesWritten = 0
  const hash = createHash('sha256')

  const meter = new Transform({
    transform(chunk, _, callback) {
      const buff = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesWritten += buff.length
      hash.update(buff)
      callback(null, buff)
    }
  })

  await pipeline(body, meter, createWriteStream(targetPath))

  if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && expectedSize >= 0) {
    if (bytesWritten !== expectedSize) {
      throw new Error(
        `Downloaded size mismatch: expected ${expectedSize} bytes but wrote ${bytesWritten} bytes`
      )
    }
  }

  if (expectedSha256Base64 && expectedSha256Base64.trim()) {
    const digest = hash.digest('base64')
    if (digest !== expectedSha256Base64.trim()) {
      throw new Error('Downloaded content checksum verification failed')
    }
  }
}

export async function downloadObjects(
  account: AwsAccount,
  bucket: string,
  keys: string[],
  destDir: string
): Promise<DownloadResult[]> {
  const client = await clientForBucket(account, bucket)
  const results: DownloadResult[] = []
  const destStat = await stat(destDir)
  if (!destStat.isDirectory()) {
    throw new Error('Destination path must be an existing directory')
  }

  for (const key of keys) {
    try {
      const targetPath = safeDownloadPath(destDir.replace(/[/\\]$/, ''), key)
      await ensureDirForFile(targetPath)
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      const body = res.Body
      if (!body) {
        throw new Error('Empty response body')
      }
      await streamWithIntegrityChecks(
        body as Readable,
        targetPath,
        res.ContentLength,
        res.ChecksumSHA256
      )
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
          ContentLength: st.size,
          ContentType: inferContentTypeFromPath(localPath)
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

const PREVIEW_MAX_BYTES = 2 * 1024 * 1024

function schedulePreviewCleanup(tempPath: string): void {
  const existing = previewCleanupTimers.get(tempPath)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    void rm(tempPath, { force: true })
    void rm(dirname(tempPath), { recursive: true, force: true })
    previewCleanupTimers.delete(tempPath)
  }, PREVIEW_TTL_MS)
  timer.unref()
  previewCleanupTimers.set(tempPath, timer)
}

export async function cleanupPreviewCache(): Promise<void> {
  for (const [tempPath, timer] of previewCleanupTimers.entries()) {
    clearTimeout(timer)
    previewCleanupTimers.delete(tempPath)
    await rm(tempPath, { force: true })
    await rm(dirname(tempPath), { recursive: true, force: true })
  }
}

function inferContentTypeFromKey(key: string): string {
  const lower = key.toLowerCase()
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml'
  if (lower.endsWith('.xml')) return 'application/xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

function inferContentTypeFromPath(localPath: string): string {
  const ext = extname(localPath).toLowerCase()
  if (ext === '.json') return 'application/json'
  if (ext === '.yaml' || ext === '.yml') return 'application/yaml'
  if (ext === '.xml') return 'application/xml'
  if (ext === '.pdf') return 'application/pdf'
  return 'application/octet-stream'
}

function looksLikePdf(raw: Buffer): boolean {
  if (raw.length < 5) return false
  return raw.subarray(0, 5).toString('ascii') === '%PDF-'
}

function resolvePreviewContentType(s3ContentType: string | undefined, key: string, raw: Buffer): string {
  const normalized = (s3ContentType ?? '').trim().toLowerCase()
  if (!normalized) {
    return inferContentTypeFromKey(key)
  }

  // Recover richer type metadata when S3 returns generic binary content.
  if (normalized.includes('application/octet-stream')) {
    if (looksLikePdf(raw) || key.toLowerCase().endsWith('.pdf')) {
      return 'application/pdf'
    }
    const inferred = inferContentTypeFromKey(key)
    if (!inferred.includes('application/octet-stream')) {
      return inferred
    }
  }

  return s3ContentType as string
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
  const contentType = resolvePreviewContentType(res.ContentType, key, raw)
  const text = contentType.toLowerCase().includes('application/pdf') ? '' : raw.toString('utf8')
  const contentRange = res.ContentRange ?? ''
  const totalMatch = /\/(\d+)$/.exec(contentRange)
  const totalBytes = totalMatch ? Number(totalMatch[1]) : Number.NaN
  const wasTruncated = Number.isFinite(totalBytes)
    ? totalBytes > PREVIEW_MAX_BYTES
    : raw.length >= PREVIEW_MAX_BYTES
  if (wasTruncated) {
    throw new Error(`Preview is limited to ${Math.round(PREVIEW_MAX_BYTES / (1024 * 1024))} MB.`)
  }

  if (contentType.includes('application/json')) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2)
      await writeFile(tempPath, pretty, 'utf8')
      schedulePreviewCleanup(tempPath)
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

  schedulePreviewCleanup(tempPath)
  const isPdf = contentType.toLowerCase().includes('application/pdf')
  return {
    key,
    tempPath,
    contentType,
    text,
    wasTruncated,
    ...(isPdf ? { pdfBase64: raw.toString('base64') } : {})
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
