import type { BucketeerApi } from '../shared/api.js'

declare global {
  interface Window {
    bucketeer: BucketeerApi
  }
}

export {}
