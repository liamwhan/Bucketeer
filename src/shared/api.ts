import type {
  AwsAccount,
  DownloadResult,
  ListObjectsRow,
  ObjectPreviewResult,
  UploadResult
} from './types.js'

export type S3BucketSummary = { Name?: string; CreationDate?: string }

export interface BucketeerApi {
  /** Generic IPC; optional for older preload builds until the app is restarted. */
  invoke?: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** Absolute path for a dropped OS file (Electron webUtils). */
  pathFromFile: (file: File) => string
  accounts: {
    list: () => Promise<AwsAccount[]>
    add: (input: Omit<AwsAccount, 'id'>) => Promise<AwsAccount>
    update: (account: AwsAccount) => Promise<void>
    remove: (id: string) => Promise<void>
  }
  s3: {
    listBuckets: (accountId: string) => Promise<S3BucketSummary[]>
    createBucket: (accountId: string, bucketName: string) => Promise<void>
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
    renameObject: (
      accountId: string,
      bucket: string,
      sourceKey: string,
      newFileName: string
    ) => Promise<{ newKey: string }>
    createFolder: (
      accountId: string,
      bucket: string,
      prefix: string,
      folderName: string
    ) => Promise<{ key: string }>
    uploadLocalFiles: (
      accountId: string,
      bucket: string,
      prefix: string,
      localPaths: string[]
    ) => Promise<UploadResult[]>
    getObjectPreview: (
      accountId: string,
      bucket: string,
      key: string
    ) => Promise<ObjectPreviewResult>
  }
}
