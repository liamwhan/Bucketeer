import type { AwsAccount, DownloadResult, ListObjectsRow } from './types.js'

export type S3BucketSummary = { Name?: string; CreationDate?: string }

export interface BucketeerApi {
  accounts: {
    list: () => Promise<AwsAccount[]>
    add: (input: Omit<AwsAccount, 'id'>) => Promise<AwsAccount>
    update: (account: AwsAccount) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  s3: {
    listBuckets: (accountId: string) => Promise<S3BucketSummary[]>
    listObjects: (
      accountId: string,
      bucket: string,
      prefix: string
    ) => Promise<{ rows: ListObjectsRow[]; isTruncated: boolean }>
    pickDownloadDir: () => Promise<string | null>
    downloadObjects: (
      accountId: string,
      bucket: string,
      keys: string[],
      destDir: string
    ) => Promise<DownloadResult[]>
  }
}
