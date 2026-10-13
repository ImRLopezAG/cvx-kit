import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ConvexHttpClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const url = `http://127.0.0.1:${process.argv[2]}`
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const queries = new Set(['list', 'plain', 'byClient', 'clientsPage', 'creditorsPage', 'ledgerList', 'draftGuard', 'unmanaged', 'state'])
const internalNames = new Set(['setup', 'mark', 'extras', 'revoke', 'state', 'corruptAmount'])
const evidence = []
const alice = { issuer: 'https://variant-fixture.test.invalid', subject: 'alice', org_id: 'fixture', role: 'finance' }
const bob = { ...alice, subject: 'bob' }
const reader = { ...alice, role: 'reader' }
async function call(name, args = {}, identity = alice) {
 const client = new ConvexHttpClient(url)
 // The local admin credential permits internal fixture setup and acting as an identity;
 // public endpoints still execute their actual createAuthFunctions policies.
 if (identity || internalNames.has(name)) client.setAdminAuth(config.adminKey, identity ?? undefined)
 const reference = (internalNames.has(name) ? internal : api).app[name]
 return queries.has(name) ? client.query(reference, args) : client.mutation(reference, args)
}
async function check(label, fn) {
 try { await fn(); evidence.push({ label, passed: true }) }
 catch (error) { evidence.push({ label, passed: false, message: error.message }); throw error }
 finally { writeFileSync('native-results.json', JSON.stringify(evidence, null, 2)) }
}
async function rejects(label, name, args, identity = alice, expected) {
 await check(label, async () => assert.rejects(async () => call(name, args, identity), error => {
  const text = String(error.message)
  assert.doesNotMatch(text, /PRIVATE-PROVIDER-EVIDENCE|PRIVATE-ATTACHMENT-EVIDENCE|PRIVATE-LEDGER-EVIDENCE/)
  if (expected) assert.match(text, expected)
  return true
 }))
}
const options = (cursor = null, filters) => {
 const args = { numItems: 2, cursor, order: 'asc' }
 if (filters) args.filters = filters
 return args
}
async function drain(name, filters, extra = {}) {
 const rows = []; let cursor = null
 for (let n = 0; n < 12; n++) {
  const result = await call(name, { ...options(cursor, filters), ...extra })
  assert.ok(result.page.length <= 2)
  rows.push(...result.page)
  if (result.isDone) return rows
  assert.ok(result.continueCursor)
  assert.notEqual(result.continueCursor, cursor)
  cursor = result.continueCursor
 }
 throw new Error('BOUNDED_CONTINUATION_EXCEEDED')
}
// The --start hook runs immediately after deploy's metadata writes. Allow the
// local backend's one-second write-rate window to clear before fixture mutations.
await delay(1500)
const ids = await call('setup')
const created = []
for (let n = 0; n < 8; n++) {
 const input = n % 2 === 0
  ? { type: 'client_draft', clientId: ids.client, amountCents: n + 1, draftDate: n }
  : { type: 'creditor_payment', clientId: ids.client, creditorId: ids.creditor, amountCents: n + 1 }
 created.push(await call('createPayment', { input }))
}
for (const n of [1, 4]) await call('mark', { id: created[n], allowed: false })
await call('extras', { payment: created[0], client: ids.client })
const expected = created.filter((_, n) => n !== 1 && n !== 4)
const mixed = await drain('list')
await check('mixed authorized continuation has exact native IDs and order', async () => assert.deepEqual(mixed.map(row => row._id), expected))
await check('mixed branches retain generated fields and private evidence is absent', async () => {
 assert.equal(new Set(mixed.map(row => row._id)).size, expected.length)
 for (const row of mixed) {
  assert.deepEqual(Object.keys(row).sort(), (row.type === 'client_draft'
   ? ['_id', 'type', 'clientId', 'amountCents', 'draftDate', 'client', 'creditor', 'attachments']
   : ['_id', 'type', 'clientId', 'amountCents', 'creditorId', 'client', 'creditor', 'attachments']).sort())
  assert.deepEqual(row.client, { _id: ids.client, name: 'client' })
  if (row.type === 'client_draft') assert.equal(row.creditor, null)
  else assert.deepEqual(row.creditor, { _id: ids.creditor, name: 'creditor' })
 }
 assert.doesNotMatch(JSON.stringify(mixed), /external|allowed|createdAt|updatedAt|_creationTime|evidence|PRIVATE-/)
})
await check('junction and attachment target authorization', async () => assert.deepEqual(mixed[0].attachments.page.map(row => row.name), ['visible']))
await check('client to mixed payments relation', async () => assert.deepEqual((await drain('byClient', undefined, { parent: ids.client })).map(row => row._id), expected))
await check('client relation cannot override parent constraint', async () => assert.deepEqual(await drain('byClient', { clientId: ids.hiddenClient }, { parent: ids.client }), []))
await check('unreadable parent produces no children', async () => assert.deepEqual(await drain('byClient', undefined, { parent: ids.hiddenClient }), []))
await rejects('wrong-table parent ID', 'byClient', { ...options(), parent: ids.creditor })
await rejects('malformed parent ID', 'byClient', { ...options(), parent: 'invalid-native-id' })
const clients = await call('clientsPage', options())
await check('ordinary client endpoint composes bounded mixed child page', async () => {
 assert.equal(clients.page.length, 1)
 assert.ok(clients.page[0].payments.page.length > 0 && clients.page[0].payments.page.length <= 3)
})
const creditors = await call('creditorsPage', options())
await check('target branch scope returns creditor payments only', async () => {
 assert.equal(creditors.page.length, 1)
 assert.ok(creditors.page[0].payments.page.length > 0)
 assert.ok(creditors.page[0].payments.page.every(row => row.type === 'creditor_payment' && row.creditorId === ids.creditor))
})
const guard = await call('draftGuard', options())
await check('draft branch does not enter creditor managed policy', async () => { assert.ok(guard.result.page.length > 0); assert.equal(guard.creditorPolicyReads, 0) })
const entries = await drain('ledgerList')
await check('optional ledger relations respect branch and absence', async () => {
 assert.equal(entries.length, 3)
 assert.equal(entries[0].payment._id, created[0])
 assert.equal(entries[0].client._id, ids.client)
 assert.equal(entries[1].payment, null)
 assert.equal(entries[1].client, null)
 assert.equal(entries[2].payment, null)
 assert.doesNotMatch(JSON.stringify(entries), /evidence|allowed|PRIVATE-/)
})
const branchFilter = { variant: { tag: 'creditor_payment', filters: { creditorId: ids.creditor } } }
const branchFirst = await call('list', options(null, branchFilter))
await check('scoped branch predicate exact IDs', async () => assert.deepEqual((await drain('list', branchFilter)).map(row => row._id), [created[3], created[5], created[7]]))
await check('branch relation eligibility predicate without widening', async () => assert.deepEqual((await drain('list', { creditor: { name: 'creditor' } })).map(row => row._id), [created[3], created[5], created[7]]))
await check('contradictory discriminator stays empty', async () => assert.deepEqual(await drain('list', { and: [{ type: 'client_draft' }, branchFilter] }), []))
await check('and/or/not branch predicates preserve eligibility', async () => assert.deepEqual((await drain('list', { and: [{ or: [{ type: 'client_draft' }, branchFilter] }, { not: { amountCents: 3 } }] })).map(row => row._id), expected.filter(id => id !== created[2])))
await rejects('unguarded branch field runtime rejection', 'list', options(null, { creditorId: ids.creditor }))
await rejects('unknown branch runtime rejection', 'list', options(null, { variant: { tag: 'unknown', filters: {} } }))
await rejects('wrong branch absent field runtime rejection', 'list', options(null, { variant: { tag: 'client_draft', filters: { creditorId: ids.creditor } } }))
await rejects('private field runtime rejection', 'list', options(null, { external: 'PRIVATE-REQUEST' }))
await rejects('wrong-table branch ID runtime rejection', 'list', options(null, { variant: { tag: 'creditor_payment', filters: { creditorId: ids.client } } }))
const first = await call('list', options())
await check('first page requires valid continuation', async () => assert.equal(first.isDone, false))
await rejects('cross-principal cursor replay', 'list', options(first.continueCursor), bob)
await rejects('changed branch filter cursor replay', 'list', options(first.continueCursor, branchFilter))
await rejects('changed selection cursor replay', 'plain', options(first.continueCursor))
await rejects('cross-table cursor replay', 'ledgerList', options(first.continueCursor))
const tampered = first.continueCursor.slice(0, -8) + 'AAAAAAAA'
await rejects('tampered cursor', 'list', options(tampered))
await check('unchanged cursor continues', async () => assert.ok((await call('list', options(first.continueCursor))).page.length > 0))
await call('revoke', { principal: 'alice', active: false })
await check('live revocation enforced on continuation', async () => assert.deepEqual((await call('list', options(first.continueCursor))).page, []))
await check('live revocation enforced on branch-scoped continuation', async () => assert.deepEqual((await call('list', options(branchFirst.continueCursor, branchFilter))).page, []))
await call('revoke', { principal: 'alice', active: true })
await check('readable client does not grant finance access', async () => {
 assert.equal((await call('clientsPage', options(), reader)).page.length, 1)
 assert.deepEqual((await call('list', options(), reader)).page, [])
})
const targetDenied = await call('createPayment', { input: { type: 'creditor_payment', clientId: ids.client, creditorId: ids.hiddenCreditor, amountCents: 100 } })
await check('unauthorized branch target is null in the actual public DTO', async () => {
 const rows = await drain('list', { amountCents: 100 })
 assert.equal(rows.length, 1)
 assert.equal(rows[0]._id, targetDenied)
 assert.equal(rows[0].creditor, null)
})
await check('hidden target cannot satisfy a relation eligibility predicate', async () => assert.deepEqual(await drain('list', { creditor: { name: 'hidden-creditor' } }), []))
const parentDenied = await call('createPayment', { input: { type: 'client_draft', clientId: ids.hiddenClient, draftDate: 1, amountCents: 101 } })
await check('unauthorized related client is null despite readable payment', async () => {
 const rows = await drain('list', { amountCents: 101 })
 assert.equal(rows[0]._id, parentDenied)
 assert.equal(rows[0].client, null)
})
await rejects('unauthenticated public query', 'list', options(), null)
await rejects('unmanaged public query', 'unmanaged', {}, null, /UNMANAGED_QUERY_CONTEXT/)
// Also hit the actual HTTP endpoint with the sanctioned generated API reference.
const http = new ConvexHttpClient(url)
await assert.rejects(async () => http.query(api.app.list, options()))
evidence.push({ label: 'unauthenticated generated API HTTP endpoint', passed: true })
const before = await call('state', { id: created[0] })
const deniedBefore = await call('state', { id: created[1] })
await rejects('update fetch authorizes current denied row', 'updatePayment', { id: created[1], data: { type: 'creditor_payment', amountCents: 99 } })
await check('denied update leaves native row and audit unchanged', async () => assert.deepEqual(await call('state', { id: created[1] }), deniedBefore))
for (const [label, data] of [
 ['invalid amount', { type: 'client_draft', amountCents: -2 }],
 ['absent branch field', { type: 'client_draft', creditorId: ids.creditor }],
 ['wrong stored tag', { type: 'creditor_payment', amountCents: 99 }],
 ['tag removal', { amountCents: 99 }],
]) {
 await rejects(`tagged update rejects ${label}`, 'updatePayment', { id: created[0], data })
 await check(`${label} leaves row and audit unchanged`, async () => assert.deepEqual(await call('state', { id: created[0] }), before))
}
await rejects('failure after row and audit writes rolls back the transaction', 'updatePayment', { id: created[0], data: { type: 'client_draft', amountCents: 99 }, failAfterPersist: true }, alice, /FIXTURE_ATOMIC_FAILURE/)
await check('post-persist failure leaves native row and audit unchanged', async () => assert.deepEqual(await call('state', { id: created[0] }), before))
await call('updatePayment', { id: created[0], data: { type: 'client_draft', amountCents: 99 } })
await check('valid tagged update persists atomically and re-parses through shared DTO', async () => {
 const after = await call('state', { id: created[0] })
 assert.equal(after.row.amountCents, 99)
 assert.equal(after.audits.length, 1)
 assert.equal(after.row.type, 'client_draft')
 assert.equal((await drain('list')).find(row => row._id === created[0]).amountCents, 99)
})
await call('corruptAmount', { id: created[0] })
const invalidStored = await call('state', { id: created[0] })
await rejects('valid partial input cannot persist invalid merged storage', 'updatePayment', { id: created[0], data: { type: 'client_draft', draftDate: 99 } })
await check('full merged validation failure leaves row and audit unchanged', async () => assert.deepEqual(await call('state', { id: created[0] }), invalidStored))
writeFileSync('native-results.json', JSON.stringify(evidence, null, 2))
writeFileSync('NATIVE_SUCCESS', `${evidence.length} native assertions passed\n`)
console.log(`Native variant shared-engine passed: ${evidence.length} assertions`)
