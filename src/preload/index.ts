import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AwsAccount } from '../shared/types.js'

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  pathFromFile: (file: File) => webUtils.getPathForFile(file),
  accounts: {
    list: (): Promise<AwsAccount[]> => ipcRenderer.invoke('accounts:list'),
    add: (input: Omit<AwsAccount, 'id'>): Promise<AwsAccount> =>
      ipcRenderer.invoke('accounts:add', input),
    update: (account: AwsAccount): Promise<void> => ipcRenderer.invoke('accounts:update', account),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id)
  },
  s3: {
    listBuckets: (accountId: string) => ipcRenderer.invoke('s3:listBuckets', accountId),
    createBucket: (accountId: string, bucketName: string) =>
      ipcRenderer.invoke('s3:createBucket', accountId, bucketName),
    listObjects: (accountId: string, bucket: string, prefix: string) =>
      ipcRenderer.invoke('s3:listObjects', accountId, bucket, prefix),
    pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('s3:pickDownloadDir'),
    downloadObjects: (accountId: string, bucket: string, keys: string[], destDir: string) =>
      ipcRenderer.invoke('s3:downloadObjects', accountId, bucket, keys, destDir),
    renameObject: (accountId: string, bucket: string, sourceKey: string, newFileName: string) =>
      ipcRenderer.invoke('s3:renameObject', accountId, bucket, sourceKey, newFileName),
    createFolder: (accountId: string, bucket: string, prefix: string, folderName: string) =>
      ipcRenderer.invoke('s3:createFolder', accountId, bucket, prefix, folderName),
    uploadLocalFiles: (
      accountId: string,
      bucket: string,
      prefix: string,
      localPaths: string[]
    ) => ipcRenderer.invoke('s3:uploadLocalFiles', accountId, bucket, prefix, localPaths),
    getObjectPreview: (accountId: string, bucket: string, key: string) =>
      ipcRenderer.invoke('s3:getObjectPreview', accountId, bucket, key),
    putObjectText: (
      accountId: string,
      bucket: string,
      key: string,
      text: string,
      contentType: string
    ) => ipcRenderer.invoke('s3:putObjectText', accountId, bucket, key, text, contentType)
  }
}

contextBridge.exposeInMainWorld('bucketeer', api)
