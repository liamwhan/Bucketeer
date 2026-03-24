import { contextBridge, ipcRenderer } from 'electron'
import type { AwsAccount } from '../shared/types.js'

const api = {
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
      ipcRenderer.invoke('s3:renameObject', accountId, bucket, sourceKey, newFileName)
  }
}

contextBridge.exposeInMainWorld('bucketeer', api)
