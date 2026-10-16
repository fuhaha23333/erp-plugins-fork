export const ACCOUNT_IPC = {
  list: 'accounts:list', save: 'accounts:save', remove: 'accounts:remove',
  open: 'accounts:open', openAll: 'accounts:open-all', manager: 'accounts:manager',
  tile: 'accounts:tile', retryLogin: 'accounts:retry-login', changed: 'accounts:changed'
} as const

export interface AccountProfile {
  id: string
  label: string
  username: string
  hasPassword: boolean
  isOpen?: boolean
}

export interface AccountInput {
  id?: string
  label: string
  username: string
  password?: string
}

export interface AccountLoginState {
  id: string
  label: string
  username: string
  status: 'checking' | 'signing-in' | 'signed-in' | 'paused' | 'failed' | 'mismatch'
  message: string
}

export interface AccountApi {
  list: () => Promise<AccountProfile[]>
  save: (input: AccountInput) => Promise<void>
  remove: (id: string) => Promise<void>
  open: (id: string | null) => Promise<void>
  openAll: () => Promise<void>
  manager: () => Promise<void>
  tile: () => Promise<void>
  retryLogin: () => Promise<void>
  onChanged: (listener: () => void) => () => void
}
