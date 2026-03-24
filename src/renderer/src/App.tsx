import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AwsAccount, ListObjectsRow } from '@shared/types'
import type { S3BucketSummary } from '@shared/api'
import {
  Cloud,
  Download,
  Box,
  Folder,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  File,
  ChevronRight,
  X
} from 'lucide-react'

function formatBytes(n: number | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

type Selection = { accountId: string; bucket: string }

export default function App(): JSX.Element {
  const [accounts, setAccounts] = useState<AwsAccount[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [bucketsMap, setBucketsMap] = useState<Record<string, S3BucketSummary[]>>({})
  const [bucketsLoading, setBucketsLoading] = useState<Set<string>>(() => new Set())
  const [bucketsError, setBucketsError] = useState<Record<string, string>>({})

  const [selection, setSelection] = useState<Selection | null>(null)
  const [prefix, setPrefix] = useState('')
  const [rows, setRows] = useState<ListObjectsRow[]>([])
  const [objectsLoading, setObjectsLoading] = useState(false)
  const [objectsError, setObjectsError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())

  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState({
    label: '',
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: ''
  })
  const [addBusy, setAddBusy] = useState(false)

  const [downloadBusy, setDownloadBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const [createBucketAccountId, setCreateBucketAccountId] = useState<string | null>(null)
  const [createBucketName, setCreateBucketName] = useState('')
  const [createBucketBusy, setCreateBucketBusy] = useState(false)
  const [createBucketError, setCreateBucketError] = useState<string | null>(null)

  const refreshAccounts = useCallback(async () => {
    const list = await window.bucketeer.accounts.list()
    setAccounts(list)
  }, [])

  useEffect(() => {
    void refreshAccounts()
  }, [refreshAccounts])

  const loadBuckets = useCallback(async (accountId: string) => {
    setBucketsLoading((s) => new Set(s).add(accountId))
    setBucketsError((e) => {
      const n = { ...e }
      delete n[accountId]
      return n
    })
    try {
      const buckets = await window.bucketeer.s3.listBuckets(accountId)
      setBucketsMap((m) => ({ ...m, [accountId]: buckets }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setBucketsError((e) => ({ ...e, [accountId]: msg }))
    } finally {
      setBucketsLoading((s) => {
        const n = new Set(s)
        n.delete(accountId)
        return n
      })
    }
  }, [])

  const toggleAccountExpanded = useCallback(
    (accountId: string) => {
      setExpanded((prev) => {
        const n = new Set(prev)
        if (n.has(accountId)) {
          n.delete(accountId)
        } else {
          n.add(accountId)
          if (!bucketsMap[accountId] && !bucketsLoading.has(accountId)) {
            void loadBuckets(accountId)
          }
        }
        return n
      })
    },
    [bucketsMap, bucketsLoading, loadBuckets]
  )

  const loadObjects = useCallback(async (sel: Selection, p: string) => {
    setObjectsLoading(true)
    setObjectsError(null)
    setSelectedKeys(new Set())
    try {
      const { rows: r, isTruncated } = await window.bucketeer.s3.listObjects(
        sel.accountId,
        sel.bucket,
        p
      )
      setRows(r)
      setTruncated(isTruncated)
    } catch (err) {
      setRows([])
      setTruncated(false)
      setObjectsError(err instanceof Error ? err.message : String(err))
    } finally {
      setObjectsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selection) {
      setRows([])
      setPrefix('')
      setTruncated(false)
      setSelectedKeys(new Set())
      return
    }
    void loadObjects(selection, prefix)
  }, [selection, prefix, loadObjects])

  const breadcrumbParts = useMemo(() => {
    if (!selection) return []
    if (!prefix) return []
    const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    return trimmed.split('/').filter(Boolean)
  }, [selection, prefix])

  const onBreadcrumbCrumb = (index: number) => {
    const parts = breadcrumbParts.slice(0, index + 1)
    const next = parts.length ? `${parts.join('/')}/` : ''
    setPrefix(next)
  }

  const onBreadcrumbRoot = () => setPrefix('')

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  const selectAllFiles = () => {
    const keys = rows.filter((r) => r.type === 'file').map((r) => r.key)
    setSelectedKeys(new Set(keys))
  }

  const clearSelection = () => setSelectedKeys(new Set())

  const onAddAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddBusy(true)
    try {
      await window.bucketeer.accounts.add({
        label: addForm.label.trim() || 'AWS account',
        region: addForm.region.trim(),
        accessKeyId: addForm.accessKeyId.trim(),
        secretAccessKey: addForm.secretAccessKey
      })
      setAddForm({
        label: '',
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: ''
      })
      setAddOpen(false)
      await refreshAccounts()
    } finally {
      setAddBusy(false)
    }
  }

  const onRemoveAccount = async (id: string) => {
    if (!confirm('Remove this account from Bucketeer? Stored keys will be deleted.')) return
    await window.bucketeer.accounts.remove(id)
    setBucketsMap((m) => {
      const n = { ...m }
      delete n[id]
      return n
    })
    setExpanded((e) => {
      const s = new Set(e)
      s.delete(id)
      return s
    })
    if (selection?.accountId === id) {
      setSelection(null)
    }
    await refreshAccounts()
  }

  const createBucketTargetAccount = useMemo(
    () => accounts.find((a) => a.id === createBucketAccountId) ?? null,
    [accounts, createBucketAccountId]
  )

  const onCreateBucket = async (e: React.FormEvent) => {
    e.preventDefault()
    const accountId = createBucketAccountId
    if (!accountId) return
    const name = createBucketName.trim()
    if (!name) return
    setCreateBucketBusy(true)
    setCreateBucketError(null)
    try {
      await window.bucketeer.s3.createBucket(accountId, name)
      setCreateBucketAccountId(null)
      setCreateBucketName('')
      await loadBuckets(accountId)
      setSelection({ accountId, bucket: name })
      setPrefix('')
      setStatusMsg(`Created bucket “${name}”.`)
    } catch (err) {
      setCreateBucketError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreateBucketBusy(false)
    }
  }

  const onDownload = async () => {
    if (!selection || selectedKeys.size === 0) return
    setDownloadBusy(true)
    setStatusMsg(null)
    try {
      const dir = await window.bucketeer.s3.pickDownloadDir()
      if (!dir) return
      const keys = [...selectedKeys]
      const results = await window.bucketeer.s3.downloadObjects(
        selection.accountId,
        selection.bucket,
        keys,
        dir
      )
      const ok = results.filter((r) => r.ok).length
      const fail = results.filter((r) => !r.ok)
      if (fail.length === 0) {
        setStatusMsg(`Downloaded ${ok} object(s) to folder.`)
      } else {
        setStatusMsg(
          `Downloaded ${ok} object(s). ${fail.length} failed: ${fail.map((f) => f.key).join(', ')}`
        )
      }
    } finally {
      setDownloadBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-pane-border px-4 py-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-7 w-7 text-sky-400" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">Bucketeer</h1>
            <p className="text-xs text-slate-500">Multi-account S3 browser</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
          >
            <Plus className="h-4 w-4" />
            Add account
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-pane-border bg-[#0c1016]">
          <div className="p-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            Accounts &amp; buckets
          </div>
          {accounts.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-500">
              No accounts yet. Add one with your region and access keys.
            </p>
          )}
          <ul className="space-y-0.5 px-1 pb-4">
            {accounts.map((acc) => {
              const isExp = expanded.has(acc.id)
              const loading = bucketsLoading.has(acc.id)
              const buckets = bucketsMap[acc.id]
              const err = bucketsError[acc.id]
              return (
                <li key={acc.id}>
                  <div className="group flex items-center gap-1 rounded px-1">
                    <button
                      type="button"
                      onClick={() => toggleAccountExpanded(acc.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-pane-hover"
                    >
                      <ChevronRight
                        className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${isExp ? 'rotate-90' : ''}`}
                      />
                      <HardDrive className="h-4 w-4 shrink-0 text-amber-500/90" />
                      <span className="truncate font-medium text-slate-200">{acc.label}</span>
                      {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />}
                    </button>
                    <button
                      type="button"
                      title="Remove account"
                      onClick={() => void onRemoveAccount(acc.id)}
                      className="rounded p-1.5 text-slate-500 opacity-0 hover:bg-red-950/50 hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {isExp && err && (
                    <p className="ml-8 mr-2 text-xs text-red-400">{err}</p>
                  )}
                  {isExp && !err && (
                    <div className="ml-4 space-y-1 border-l border-pane-border pl-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setCreateBucketAccountId(acc.id)
                          setCreateBucketName('')
                          setCreateBucketError(null)
                        }}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium text-sky-400 hover:bg-pane-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Plus className="h-3.5 w-3.5 shrink-0" />
                        New bucket
                      </button>
                      {loading && !buckets && (
                        <p className="px-2 py-1 text-xs text-slate-500">Loading buckets…</p>
                      )}
                      {buckets && buckets.length === 0 && !loading && (
                        <p className="px-2 py-1 text-xs text-slate-500">No buckets yet.</p>
                      )}
                      {buckets && buckets.length > 0 && (
                        <ul className="space-y-0.5">
                          {buckets.map((b) => {
                            const name = b.Name ?? ''
                            if (!name) return null
                            const sel =
                              selection?.accountId === acc.id && selection.bucket === name
                            return (
                              <li key={name}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelection({ accountId: acc.id, bucket: name })
                                    setPrefix('')
                                  }}
                                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                                    sel
                                      ? 'bg-sky-950/80 text-sky-100'
                                      : 'text-slate-300 hover:bg-pane-hover'
                                  }`}
                                >
                                  <Box className="h-4 w-4 shrink-0 text-sky-500/90" />
                                  <span className="truncate">{name}</span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-pane-bg">
          {!selection && (
            <div className="flex flex-1 items-center justify-center text-slate-500">
              Select a bucket to browse objects.
            </div>
          )}
          {selection && (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-pane-border px-3 py-2">
                <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                  <button
                    type="button"
                    onClick={onBreadcrumbRoot}
                    className="truncate font-medium text-sky-400 hover:underline"
                  >
                    {selection.bucket}
                  </button>
                  {breadcrumbParts.map((part, i) => (
                    <span key={`${i}-${part}`} className="flex items-center gap-1">
                      <span className="text-slate-600">/</span>
                      <button
                        type="button"
                        onClick={() => onBreadcrumbCrumb(i)}
                        className="truncate text-sky-400 hover:underline"
                      >
                        {part}
                      </button>
                    </span>
                  ))}
                </nav>
                <button
                  type="button"
                  onClick={() => void loadObjects(selection, prefix)}
                  disabled={objectsLoading}
                  className="inline-flex items-center gap-1 rounded border border-pane-border px-2 py-1 text-xs text-slate-300 hover:bg-pane-hover disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${objectsLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={selectAllFiles}
                  className="rounded border border-pane-border px-2 py-1 text-xs text-slate-300 hover:bg-pane-hover"
                >
                  Select all files
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded border border-pane-border px-2 py-1 text-xs text-slate-300 hover:bg-pane-hover"
                >
                  Clear selection
                </button>
                <button
                  type="button"
                  onClick={() => void onDownload()}
                  disabled={downloadBusy || selectedKeys.size === 0}
                  className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {downloadBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Download ({selectedKeys.size})
                </button>
              </div>
              {truncated && (
                <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200/90">
                  This listing is truncated by AWS (max 1000 keys per request). Pagination can be
                  added later.
                </div>
              )}
              {objectsError && (
                <div className="border-b border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
                  {objectsError}
                </div>
              )}
              {statusMsg && (
                <div className="flex items-center justify-between border-b border-emerald-900/40 bg-emerald-950/25 px-3 py-1.5 text-xs text-emerald-200">
                  <span>{statusMsg}</span>
                  <button
                    type="button"
                    onClick={() => setStatusMsg(null)}
                    className="rounded p-0.5 hover:bg-emerald-900/40"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-[#121a24] text-xs uppercase text-slate-500">
                    <tr>
                      <th className="w-10 px-3 py-2" />
                      <th className="px-3 py-2">Name</th>
                      <th className="w-36 px-3 py-2">Size</th>
                      <th className="w-52 px-3 py-2">Modified</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-pane-border">
                    {objectsLoading && rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-slate-500">
                          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                        </td>
                      </tr>
                    )}
                    {!objectsLoading && rows.length === 0 && !objectsError && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-slate-500">
                          This folder is empty.
                        </td>
                      </tr>
                    )}
                    {rows.map((row) => {
                      if (row.type === 'folder') {
                        return (
                          <tr key={`f-${row.prefix}`} className="hover:bg-pane-hover/80">
                            <td className="px-3 py-1.5" />
                            <td className="px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => setPrefix(row.prefix)}
                                className="inline-flex items-center gap-2 text-slate-200 hover:text-white"
                              >
                                <Folder className="h-4 w-4 text-amber-500/90" />
                                <span>{row.name}</span>
                              </button>
                            </td>
                            <td className="px-3 py-1.5 text-slate-500">—</td>
                            <td className="px-3 py-1.5 text-slate-500">—</td>
                          </tr>
                        )
                      }
                      const checked = selectedKeys.has(row.key)
                      return (
                        <tr
                          key={row.key}
                          className={`hover:bg-pane-hover/80 ${checked ? 'bg-sky-950/20' : ''}`}
                        >
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleKey(row.key)}
                              className="h-3.5 w-3.5 rounded border-slate-600 bg-[#0c1016]"
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <span className="inline-flex items-center gap-2 text-slate-200">
                              <File className="h-4 w-4 text-slate-400" />
                              {row.name}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-400">
                            {formatBytes(row.size)}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-slate-500">
                            {formatDate(row.lastModified)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </main>
      </div>

      {createBucketAccountId && createBucketTargetAccount && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-bucket-title"
            className="w-full max-w-md rounded-lg border border-pane-border bg-[#121a24] p-5 shadow-xl"
          >
            <h2 id="create-bucket-title" className="text-lg font-semibold text-white">
              New bucket
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Account: <span className="text-slate-300">{createBucketTargetAccount.label}</span>
              {' · '}
              Region:{' '}
              <span className="font-mono text-slate-300">{createBucketTargetAccount.region}</span>
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Name must be globally unique and follow{' '}
              <a
                className="text-sky-400 hover:underline"
                href="https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html"
                target="_blank"
                rel="noreferrer"
              >
                S3 bucket naming rules
              </a>
              .
            </p>
            <form onSubmit={(e) => void onCreateBucket(e)} className="mt-4 space-y-3">
              {createBucketError && (
                <p className="rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                  {createBucketError}
                </p>
              )}
              <label className="block text-sm">
                <span className="text-slate-400">Bucket name</span>
                <input
                  required
                  autoFocus
                  autoComplete="off"
                  value={createBucketName}
                  onChange={(e) => setCreateBucketName(e.target.value)}
                  className="mt-1 w-full rounded border border-pane-border bg-[#0c1016] px-3 py-2 font-mono text-sm text-white outline-none focus:border-sky-600"
                  placeholder="my-unique-bucket-name"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setCreateBucketAccountId(null)
                    setCreateBucketName('')
                    setCreateBucketError(null)
                  }}
                  className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-pane-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createBucketBusy || !createBucketName.trim()}
                  className="inline-flex items-center gap-2 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {createBucketBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-account-title"
            className="w-full max-w-md rounded-lg border border-pane-border bg-[#121a24] p-5 shadow-xl"
          >
            <h2 id="add-account-title" className="text-lg font-semibold text-white">
              Add AWS account
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Credentials are stored locally on this machine only (plain JSON for now).
            </p>
            <form onSubmit={(e) => void onAddAccount(e)} className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="text-slate-400">Display name</span>
                <input
                  required
                  value={addForm.label}
                  onChange={(e) => setAddForm((f) => ({ ...f, label: e.target.value }))}
                  className="mt-1 w-full rounded border border-pane-border bg-[#0c1016] px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
                  placeholder="e.g. Personal, Work"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Region</span>
                <input
                  required
                  value={addForm.region}
                  onChange={(e) => setAddForm((f) => ({ ...f, region: e.target.value }))}
                  className="mt-1 w-full rounded border border-pane-border bg-[#0c1016] px-3 py-2 text-sm text-white outline-none focus:border-sky-600"
                  placeholder="us-east-1"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Access key ID</span>
                <input
                  required
                  autoComplete="off"
                  value={addForm.accessKeyId}
                  onChange={(e) => setAddForm((f) => ({ ...f, accessKeyId: e.target.value }))}
                  className="mt-1 w-full rounded border border-pane-border bg-[#0c1016] px-3 py-2 font-mono text-sm text-white outline-none focus:border-sky-600"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">Secret access key</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={addForm.secretAccessKey}
                  onChange={(e) =>
                    setAddForm((f) => ({ ...f, secretAccessKey: e.target.value }))
                  }
                  className="mt-1 w-full rounded border border-pane-border bg-[#0c1016] px-3 py-2 font-mono text-sm text-white outline-none focus:border-sky-600"
                />
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  className="rounded px-3 py-1.5 text-sm text-slate-300 hover:bg-pane-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addBusy}
                  className="inline-flex items-center gap-2 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {addBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
