import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type { AwsAccount } from '../shared/types.js'

const fileName = 'accounts.json'

type StoreShape = { accounts: AwsAccount[] }

function storePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, fileName)
}

function readStore(): StoreShape {
  const p = storePath()
  if (!existsSync(p)) {
    return { accounts: [] }
  }
  try {
    const raw = readFileSync(p, 'utf-8')
    const data = JSON.parse(raw) as StoreShape
    if (!data || !Array.isArray(data.accounts)) {
      return { accounts: [] }
    }
    return { accounts: data.accounts }
  } catch {
    return { accounts: [] }
  }
}

function writeStore(data: StoreShape): void {
  writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function listAccounts(): AwsAccount[] {
  return readStore().accounts
}

export function addAccount(input: Omit<AwsAccount, 'id'>): AwsAccount {
  const account: AwsAccount = {
    ...input,
    id: randomUUID()
  }
  const store = readStore()
  store.accounts.push(account)
  writeStore(store)
  return account
}

export function updateAccount(account: AwsAccount): void {
  const store = readStore()
  const i = store.accounts.findIndex((a) => a.id === account.id)
  if (i === -1) {
    throw new Error('Account not found')
  }
  store.accounts[i] = account
  writeStore(store)
}

export function removeAccount(id: string): void {
  const store = readStore()
  store.accounts = store.accounts.filter((a) => a.id !== id)
  writeStore(store)
}

export function getAccount(id: string): AwsAccount | undefined {
  return readStore().accounts.find((a) => a.id === id)
}
