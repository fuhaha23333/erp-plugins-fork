import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore } from '../src/main/account-store'

function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'erp-account-store-')), 'accounts.json')
  const codec = { encrypt: (value: string) => Buffer.from(value).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() }
  return { file, codec, store: new AccountStore(file, codec) }
}
const input = { label: '采购', username: 'buyer', password: 'synthetic-password-1' }
const origin = 'https://erp.example.test'

test('account persistence exposes no secrets and retains an omitted password', () => {
  const { file, codec, store } = fixture()
  store.save(input, origin)
  const profile = store.list()[0]
  assert.deepEqual(Object.keys(profile).sort(), ['hasPassword', 'id', 'label', 'username'])
  assert.ok(!readFileSync(file, 'utf8').includes(input.password))
  store.save({ ...profile, label: '采购二部' }, origin)
  const restored = new AccountStore(file, codec)
  assert.equal(restored.credentials(profile.id, origin).password, input.password)
  assert.equal(restored.get(profile.id).label, '采购二部')
  assert.throws(() => restored.credentials(profile.id, 'https://another.example.test'), /地址已变化/)
})

test('account identities have isolated partitions and changes require a fresh password', () => {
  const { store } = fixture()
  store.save(input, origin)
  const first = store.list()[0]
  const partition = store.partition(first.id)
  assert.throws(() => store.save(input, origin), /已经配置/)
  assert.throws(() => store.save({ ...first, username: 'other' }, origin), /需要填写密码/)
  store.save({ ...first, username: 'other', password: 'new-secret' }, origin)
  assert.notEqual(store.partition(first.id), partition)
  store.save(input, origin)
  assert.equal(new Set(store.list().map(account => store.partition(account.id))).size, 2)
})

test('saved account count is not capped and legacy startup flags do not exclude accounts', () => {
  const { file, codec, store } = fixture()
  for (let i = 0; i < 12; i++) store.save({ ...input, username: `user${i}` }, origin)
  assert.equal(store.list().length, 12)
  const legacy = JSON.parse(readFileSync(file, 'utf8'))
  for (const [index, account] of legacy.accounts.entries()) account.autoOpen = index % 2 === 0
  writeFileSync(file, JSON.stringify(legacy))
  const restored = new AccountStore(file, codec)
  assert.equal(restored.list().length, 12)
  assert.ok(restored.list().every(account => !('autoOpen' in account)))
  assert.equal(restored.credentials(restored.list()[1].id, origin).password, input.password)
  const account = store.list()[0]
  store.remove(account.id)
  assert.throws(() => store.credentials(account.id, origin))
})

test('unavailable encryption and damaged files never fall back to plaintext or reset data', () => {
  const { file, store } = fixture()
  store.save(input, origin)
  const previous = readFileSync(file, 'utf8')
  const locked = new AccountStore(file, { encrypt: () => { throw Error('locked') }, decrypt: () => { throw Error('locked') } })
  assert.throws(() => locked.save({ ...input, username: 'second' }, origin), /locked/)
  assert.equal(readFileSync(file, 'utf8'), previous)
  assert.throws(() => locked.credentials(store.list()[0].id, origin), /无法解密/)
  writeFileSync(file, '{broken')
  assert.throws(() => new AccountStore(file, { encrypt: String, decrypt: String }), /无法读取/)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
})
