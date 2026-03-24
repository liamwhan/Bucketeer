export type AwsAccount = {
  id: string
  label: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export type ListObjectsFolder = { type: 'folder'; name: string; prefix: string }
export type ListObjectsFile = {
  type: 'file'
  key: string
  name: string
  size: number | undefined
  lastModified: string | undefined
}

export type ListObjectsRow = ListObjectsFolder | ListObjectsFile

export type DownloadResult =
  | { key: string; ok: true; path: string }
  | { key: string; ok: false; error: string }

export type UploadResult =
  | { key: string; localPath: string; ok: true }
  | { key: string; localPath: string; ok: false; error: string }
