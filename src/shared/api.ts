import type {
  AwsAccount,
  DownloadResult,
  ListObjectsRow,
  ObjectPreviewResult,
  SaveObjectResult,
  UploadResult
} from './types.js'

export type S3BucketSummary = { Name?: string; CreationDate?: string }

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
}

export type MenuAction = 'about' | 'checkForUpdates'

export interface BucketeerApi {
  app: {
    getVersion: () => Promise<string>
    checkForUpdates: () => Promise<UpdateCheckResult>
    openReleasePage: (url: string) => Promise<void>
    /** Subscribes to native menu actions; returns an unsubscribe function. */
    onMenuAction: (callback: (action: MenuAction) => void) => () => void
  }
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
    putObjectText: (
      accountId: string,
      bucket: string,
      key: string,
      text: string,
      contentType: string
    ) => Promise<SaveObjectResult>
  }
}
