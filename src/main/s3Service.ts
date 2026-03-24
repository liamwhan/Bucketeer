import { mkdir, createWriteStream } from 'fs'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import type { Readable } from 'stream'
import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  CreateBucketCommand,
  type Bucket,
  type BucketLocationConstraint
} from '@aws-sdk/client-s3'
import type { AwsAccount, ListObjectsRow, DownloadResult } from '../shared/types.js'

const clientCache = new Map<string, S3Client>()

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

export function clearClientCache(accountId?: string): void {
  if (accountId) {
    for (const k of clientCache.keys()) {
      if (k.startsWith(`${accountId}:`)) {
        clientCache.delete(k)
      }
    }
    return
  }
  clientCache.clear()
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
  const client = clientFor(account)
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/'
    })
  )

  const rows: ListObjectsRow[] = []

  for (const cp of res.CommonPrefixes ?? []) {
    const p = cp.Prefix ?? ''
    const base = stripTrailingSlash(p)
    const name = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base
    if (name) {
      rows.push({ type: 'folder', name, prefix: p })
    }
  }

  for (const obj of res.Contents ?? []) {
    const key = obj.Key ?? ''
    if (!key || key === prefix) continue
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
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return { rows, isTruncated: Boolean(res.IsTruncated) }
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
  const client = clientFor(account)
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
