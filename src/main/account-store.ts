import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccountInput, AccountProfile } from '../shared/accounts'

export interface SavedBounds { x: number; y: number; width: number; height: number }
interface StoredAccount {
  id: string; label: string; username: string
  secret: string; origin: string; bounds?: SavedBounds
}
export interface SecretCodec { encrypt: (value: string) => string; decrypt: (value: string) => string }

export class AccountStore {
  private records: StoredAccount[] = []

  constructor(private readonly file: string, private readonly codec: SecretCodec) {
    if (!existsSync(file)) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error()
      const ids = new Set<string>()
      for (const record of data.accounts) {
        if (!record || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) || ids.has(record.id) ||
          typeof record.label !== 'string' || typeof record.username !== 'string' ||
          typeof record.secret !== 'string' || typeof record.origin !== 'string') throw new Error()
        ids.add(record.id)
      }
      // Older files may contain autoOpen; all saved accounts now participate in startup.
      this.records = data.accounts.map(({ id, label, username, secret, origin, bounds }: StoredAccount) =>
        ({ id, label, username, secret, origin, bounds }))
    } catch { throw new Error('账号配置文件无法读取，请保留原文件并检查后重试') }
  }

  list(): AccountProfile[] {
    return this.records.map(({ id, label, username, secret }) => ({ id, label, username, hasPassword: Boolean(secret) }))
  }

  get(id: string): AccountProfile {
    const profile = this.list().find(record => record.id === id)
    if (!profile) throw new Error('账号不存在')
    return profile
  }

  partition(id: string): string {
    const record = this.records.find(item => item.id === id)
    if (!record) throw new Error('账号不存在')
    const identity = createHash('sha256').update(`${record.origin}\0${record.username}`).digest('hex').slice(0, 16)
    return `persist:erp-account-${id}-${identity}`
  }

  credentials(id: string, origin: string): { username: string; password: string } {
    const record = this.records.find(record => record.id === id)
    if (!record || record.origin !== origin) throw new Error('ERP 地址已变化，请重新保存此账号密码')
    try { return { username: record.username, password: this.codec.decrypt(record.secret) } }
    catch { throw new Error('无法解密此账号密码，请在当前 Windows 用户下重新设置') }
  }

  save(value: unknown, origin: string): void {
    if (!origin) throw new Error('请先配置 ERP 地址')
    if (!value || typeof value !== 'object') throw new Error('账号配置无效')
    const input = value as AccountInput
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80 ||
      typeof input.username !== 'string' || !input.username.trim() || input.username.length > 128 ||
      (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 1024))) {
      throw new Error('请填写有效的账号备注、用户名和密码')
    }
    const previous = input.id === undefined ? undefined : this.records.find(record => record.id === input.id)
    if (input.id !== undefined && !previous) throw new Error('账号不存在')
    if (this.records.some(record => record.id !== input.id && record.username.toLowerCase() === input.username.trim().toLowerCase() && record.origin === origin)) {
      throw new Error('该用户名已经配置，请编辑已有账号')
    }
    if (!input.password && (!previous || previous.username !== input.username.trim() || previous.origin !== origin)) throw new Error('新增账号或修改用户名、ERP 地址时需要填写密码')
    const record: StoredAccount = {
      id: previous?.id ?? randomUUID(), label: input.label.trim(), username: input.username.trim(),
      origin, bounds: previous?.bounds,
      secret: input.password ? this.codec.encrypt(input.password) : previous!.secret
    }
    const next = previous ? this.records.map(item => item.id === previous.id ? record : item) : [...this.records, record]
    this.commit(next)
  }

  remove(id: string): void { this.get(id); this.commit(this.records.filter(record => record.id !== id)) }
  bounds(id: string): SavedBounds | undefined { return this.records.find(record => record.id === id)?.bounds }
  saveBounds(id: string, bounds: SavedBounds): void {
    if (!this.records.some(record => record.id === id)) return
    this.commit(this.records.map(record => record.id === id ? { ...record, bounds } : record))
  }

  private commit(records: StoredAccount[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, accounts: records }, null, 2), { mode: 0o600 })
    renameSync(temporary, this.file)
    this.records = records
  }
}
