import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { ConvexHttpClient, ConvexClient } from 'convex/browser'
import { api, internal } from './convex/_generated/api.js'

const url = `http://127.0.0.1:${process.argv[2]}`
const config = JSON.parse(readFileSync('.convex/local/default/config.json', 'utf8'))
const queries = new Set(['list', 'plain', 'byClient', 'clientsPage', 'creditorsPage', 'ledgerList', 'draftGuard', 'unmanaged', 'state', 'taskList', 'deepTasks', 'nativeClients', 'taskState', 'ledgerState', 'timestampContracts', 'declarationContracts', 'inverseTasks', 'inverseLeads', 'inverseContacts', 'inverseClients', 'inverseCreditors', 'inverseDeals', 'inversePayments', 'inverseLedger', 'inverseClientsDeclaration', 'inverseClientsPolicy', 'nestedClientTasks', 'nestedReferenceTasks'])
const internalNames = new Set(['setup', 'mark', 'extras', 'revoke', 'state', 'corruptAmount', 'nativeSetup', 'seedTask', 'taskState', 'ledgerState', 'department', 'nativeNumber', 'timestampContracts', 'declarationContracts', 'rawLedger', 'financeMembership'])
const evidence = []
const started = performance.now()
const queryLimit = 2
let activeQueries = 0
const queryWaiters = []
const timings = { calls: {}, assertions: [], queryConcurrency: { limit: queryLimit, maxActive: 0, maxQueued: 0 } }
async function runQuery(request) {
 if (activeQueries >= queryLimit) {
  await new Promise(resolve => {
   queryWaiters.push(resolve)
   timings.queryConcurrency.maxQueued = Math.max(timings.queryConcurrency.maxQueued, queryWaiters.length)
  })
 } else activeQueries++
 timings.queryConcurrency.maxActive = Math.max(timings.queryConcurrency.maxActive, activeQueries)
 try { return await request() }
 finally {
  // Transfer the occupied slot directly so new calls cannot overtake a queued query.
  const next = queryWaiters.shift()
  if (next) next()
  else activeQueries--
 }
}
function saveTimings() {
 writeFileSync('native-timings.json', JSON.stringify({ elapsedMs: performance.now() - started, ...timings }, null, 2))
}
const alice = { issuer: 'https://variant-fixture.test.invalid', subject: 'alice', org_id: 'fixture', role: 'finance' }
const bob = { ...alice, subject: 'bob' }
const reader = { ...alice, role: 'reader' }
async function call(name, args = {}, identity = alice) {
 const client = new ConvexHttpClient(url)
 // The local admin credential permits internal fixture setup and acting as an identity;
 // public endpoints still execute their actual createAuthFunctions policies.
 if (identity || internalNames.has(name)) client.setAdminAuth(config.adminKey, identity ?? undefined)
 const reference = (internalNames.has(name) ? internal : api).app[name]
 const callStarted = performance.now()
 try { return await (queries.has(name) ? runQuery(() => client.query(reference, args)) : client.mutation(reference, args)) }
 finally {
  // Record only fixed endpoint names and durations, never arguments, identity or credentials.
  const timing = timings.calls[name] ??= { kind: queries.has(name) ? 'query' : 'mutation', count: 0, totalMs: 0, maxMs: 0 }
  const elapsed = performance.now() - callStarted
  timing.count++; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed)
 }
}
async function check(label, fn) {
 const checkStarted = performance.now()
 try { await fn(); evidence.push({ label, passed: true }) }
 catch (error) { evidence.push({ label, passed: false, message: error.message }); throw error }
 finally {
  timings.assertions.push({ label, milliseconds: performance.now() - checkStarted })
  writeFileSync('native-results.json', JSON.stringify(evidence, null, 2))
  saveTimings()
 }
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
async function drain(name, filters, extra = {}, identity = alice, maxPages = 12) {
 const rows = []; let cursor = null
 for (let n = 0; n < maxPages; n++) {
  const result = await call(name, { ...options(cursor, filters), ...extra }, identity)
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
// These assertions read stable state; each drain still follows its cursor serially.
await Promise.all([
 check('mixed authorized continuation has exact native IDs and order', async () => assert.deepEqual(mixed.map(row => row._id), expected)),
 check('mixed branches retain generated fields and private evidence is absent', async () => {
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
}),
 check('junction and attachment target authorization', async () => assert.deepEqual(mixed[0].attachments.page.map(row => row.name), ['visible'])),
 check('client to mixed payments relation', async () => assert.deepEqual((await drain('byClient', undefined, { parent: ids.client })).map(row => row._id), expected)),
 check('client relation cannot override parent constraint', async () => assert.deepEqual(await drain('byClient', { clientId: ids.hiddenClient }, { parent: ids.client }), [])),
 check('unreadable parent produces no children', async () => assert.deepEqual(await drain('byClient', undefined, { parent: ids.hiddenClient }), [])),
 rejects('wrong-table parent ID', 'byClient', { ...options(), parent: ids.creditor }),
 rejects('malformed parent ID', 'byClient', { ...options(), parent: 'invalid-native-id' }),
])
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
// These assertions read stable state; each drain still follows its cursor serially.
await Promise.all([
 check('scoped branch predicate exact IDs', async () => assert.deepEqual((await drain('list', branchFilter)).map(row => row._id), [created[3], created[5], created[7]])),
 check('branch relation eligibility predicate without widening', async () => assert.deepEqual((await drain('list', { creditor: { name: 'creditor' } })).map(row => row._id), [created[3], created[5], created[7]])),
 check('contradictory discriminator stays empty', async () => assert.deepEqual(await drain('list', { and: [{ type: 'client_draft' }, branchFilter] }), [])),
 check('and/or/not branch predicates preserve eligibility', async () => assert.deepEqual((await drain('list', { and: [{ or: [{ type: 'client_draft' }, branchFilter] }, { not: { amountCents: 3 } }] })).map(row => row._id), expected.filter(id => id !== created[2]))),
 rejects('unguarded branch field runtime rejection', 'list', options(null, { creditorId: ids.creditor })),
 rejects('unknown branch runtime rejection', 'list', options(null, { variant: { tag: 'unknown', filters: {} } })),
 rejects('wrong branch absent field runtime rejection', 'list', options(null, { variant: { tag: 'client_draft', filters: { creditorId: ids.creditor } } })),
 rejects('private field runtime rejection', 'list', options(null, { external: 'PRIVATE-REQUEST' })),
 rejects('wrong-table branch ID runtime rejection', 'list', options(null, { variant: { tag: 'creditor_payment', filters: { creditorId: ids.client } } })),
])
const first = await call('list', options())
// These assertions read stable state; each drain still follows its cursor serially.
await Promise.all([
 check('first page requires valid continuation', async () => assert.equal(first.isDone, false)),
 rejects('cross-principal cursor replay', 'list', options(first.continueCursor), bob),
 rejects('changed branch filter cursor replay', 'list', options(first.continueCursor, branchFilter)),
 rejects('changed selection cursor replay', 'plain', options(first.continueCursor)),
 rejects('cross-table cursor replay', 'ledgerList', options(first.continueCursor)),
])
const tampered = first.continueCursor.slice(0, -8) + 'AAAAAAAA'
// These assertions read stable state; each drain still follows its cursor serially.
await Promise.all([
 rejects('tampered cursor', 'list', options(tampered)),
 check('unchanged cursor continues', async () => assert.ok((await call('list', options(first.continueCursor))).page.length > 0)),
])
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
// Issue 36 native-ID union acceptance. All setup/inspection remains internal;
// every successful create/relink/clear and all reads below use generated public APIs.
const native = await call('nativeSetup')
const members = ['tasks', 'leads', 'contacts', 'clients', 'creditors', 'deals', 'payments', 'ledger']
const fields = { tasks: 'referenceTask', leads: 'lead', contacts: 'contact', clients: 'client', creditors: 'creditor', deals: 'deal', payments: 'payment', ledger: 'ledgerEntry' }
const endpoint = table => 'inverse' + table[0].toUpperCase() + table.slice(1)
const input = (name, rel, status = 'open') => ({ name, status, rel })
const taskIds = {}; const childIds = {}; const publicPages = []
const taskOnly = { ...alice, subject: 'taskOnly', role: 'taskOnly' }
const targetOnly = { ...alice, subject: 'targetOnly', role: 'targetOnly' }
const carol = { ...alice, subject: 'carol' }
const rowFor = async (name, identity = alice) => (await drain('taskList', { name }, {}, identity))[0]
const inverse = (table, parent = native.targets[table], filters, identity = alice) => drain(endpoint(table), filters, { parent }, identity)
function privateScan(value) {
 assert.doesNotMatch(JSON.stringify(value), /"(?:allowed|department|linkAllowed|dependentClient|secret|evidence|external|previous|next|operation|_creationTime|updatedAt|finance)"|PRIVATE-/)
}
// Observe reactivity before the member matrix accumulates unrelated tasks.
// The root name predicate is residual (no name index), so a two-item page
// still authorizes every candidate. Keep all three live observers and their
// public query shapes, but run against nativeSetup's bounded task inventory.
// Use the same native WebSocket constructor resolution as fixture-effect/pagination.mjs.
// Each observation is bounded, and every subscription/socket is closed on failure.
const require = createRequire(import.meta.url)
const WebSocket = require(require.resolve('ws', { paths: [require.resolve('convex/package.json')] }))
const live = new ConvexClient(url, { webSocketConstructor: WebSocket })
live.setAdminAuth(config.adminKey, alice)
const unsubscribers = []; const observations = new Map(); const waiters = new Set()
let subscriptionError
function signal() { for (const waiter of waiters) waiter() }
function observed(accept) {
 return new Promise((resolve, reject) => {
  const finish = () => {
   if (subscriptionError) { clearTimeout(timer); waiters.delete(finish); reject(subscriptionError) }
   else if (accept()) { clearTimeout(timer); waiters.delete(finish); resolve() }
  }
  const timer = setTimeout(() => { waiters.delete(finish); reject(new Error('ISSUE36_SUBSCRIPTION_TIMEOUT_25000MS')) }, 25000)
  waiters.add(finish); finish()
 })
}
try {
 const reactive = await call('createTask', { input: input('native-reactive', native.targets.clients) })
 for (const [key, reference, args] of [
  ['root', api.app.taskList, options(null, { name: 'native-reactive' })],
  ['old', api.app.inverseClients, { ...options(null, { name: 'native-reactive' }), parent: native.targets.clients }],
  ['next', api.app.inverseLeads, { ...options(null, { name: 'native-reactive' }), parent: native.targets.leads }],
 ]) unsubscribers.push(live.onUpdate(reference, args, page => { observations.set(key, page); signal() }, error => { subscriptionError = error; signal() }))
 await check('issue36/native subscriptions observe initial public root and inverse', async () => {
  await observed(() => observations.get('root')?.page[0]?.client?._id === native.targets.clients && observations.get('old')?.page[0]?._id === reactive && observations.get('next')?.page.length === 0)
 })
 await call('updateTask', { id: reactive, data: { rel: native.targets.leads } })
 await check('issue36/native subscriptions react to relink old and new inverse', async () => {
  await observed(() => observations.get('root')?.page[0]?.lead?._id === native.targets.leads && observations.get('old')?.page.length === 0 && observations.get('next')?.page[0]?._id === reactive)
 })
 await call('updateTask', { id: reactive, data: { rel: null } })
 await check('issue36/native subscriptions react to clear root and both inverse', async () => {
  await observed(() => observations.get('root')?.page[0]?.rel === null && observations.get('old')?.page.length === 0 && observations.get('next')?.page.length === 0)
  privateScan([...observations.values()])
 })
} finally {
 for (const unsubscribe of unsubscribers) unsubscribe()
 await live.close()
}

await check('issue36/declarations runtime ownership and invalid narrowing contracts', async () => assert.deepEqual(await call('declarationContracts'), Array(11).fill(true)))
for (const table of members) {
 const name = 'native-link-' + table
 const target = native.targets[table]
 const deniedSource = await call('seedTask', { input: input('native-denied-source-' + table, target), allowed: false, department: 'A' })
 await call('seedTask', { input: input('native-other-source-' + table, target), allowed: true, department: 'B' })
 const task = await call('createTask', { input: input(name, target) })
 taskIds[table] = task
 const children = [task]
 for (let n = 0; n < 3; n++) children.push(await call('createTask', { input: input(name + '-child-' + n, target, n === 1 ? 'done' : 'open') }))
 childIds[table] = children
 // No writes occur until every independent read assertion finishes.
 await Promise.all([
 check(`issue36/${table}/public create native union and forward exact target`, async () => {
  const row = await rowFor(name)
  assert.equal(row._id, task); assert.equal(row.rel, target); assert.equal(row[fields[table]]._id, target)
  for (const other of members.filter(member => member !== table)) assert.equal(row[fields[other]], null)
  publicPages.push(row)
 }),
 check(`issue36/${table}/inverse indexed authorized fill gapless continuation`, async () => {
  const rows = await inverse(table)
  assert.deepEqual(rows.map(row => row._id), children)
  assert.equal(new Set(rows.map(row => row._id)).size, children.length)
  privateScan(rows); publicPages.push(rows)
 }),
 check(`issue36/${table}/inverse filter before page fill logical status`, async () => {
  assert.deepEqual((await inverse(table, target, { and: [{ status: 'open' }, { not: { name: name + '-child-1' } }] })).map(row => row._id), [children[0], children[1], children[3]])
 }),
 ])
 const first = await call(endpoint(table), { ...options(), parent: target })
 assert.equal(first.isDone, false)
 assert.ok(first.continueCursor)
 await check(`issue36/${table}/unchanged child cursor continues exact remainder`, async () => assert.deepEqual((await call(endpoint(table), { ...options(first.continueCursor), parent: target })).page.map(row => row._id), children.slice(2)))
 await Promise.all([
  ['parent', { ...options(first.continueCursor), parent: native.forbidden[table] }, alice],
  ['actor', { ...options(first.continueCursor), parent: target }, bob],
  ['scope', { ...options(first.continueCursor), parent: target }, { ...alice, org_id: 'other-scope' }],
  ['filter', { ...options(first.continueCursor, { status: 'done' }), parent: target }, alice],
  ['order', { ...options(first.continueCursor), parent: target, order: 'desc' }, alice],
  ['malformed', { ...options('malformed'), parent: target }, alice],
  ['tampered', { ...options(first.continueCursor.slice(0, -8) + 'AAAAAAAA'), parent: target }, alice],
 ].map(([axis, replay, actor]) => rejects(`issue36/${table}/cursor rejects ${axis}`, endpoint(table), replay, actor)))
 const otherTable = members[(members.indexOf(table) + 1) % members.length]
 await rejects(`issue36/${table}/cursor rejects different narrowed member`, endpoint(otherTable), { ...options(first.continueCursor), parent: native.targets[otherTable] })
 await rejects(`issue36/${table}/child cursor rejects root endpoint`, 'taskList', options(first.continueCursor))
 const [rejectionState, rejectionInverse] = await Promise.all([call('taskState', { id: task }), inverse(table)])
 for (const kind of ['missing', 'denied', 'forbidden', 'otherDepartment']) {
  await check(`issue36/${table}/${kind} link rejection preserves task inverse audit atomically`, async () => {
   const targetInverse = await inverse(table, native[kind][table])
   await assert.rejects(() => call('createTask', { input: input('native-rejected-' + table + '-' + kind, native[kind][table]) }))
   await assert.rejects(() => call('updateTask', { id: task, data: { rel: native[kind][table] } }))
   const [after, oldAfter, targetAfter, rejectedRow] = await Promise.all([
    call('taskState', { id: task }), inverse(table), inverse(table, native[kind][table]),
    rowFor('native-rejected-' + table + '-' + kind),
   ])
   assert.deepEqual(after, rejectionState)
   assert.deepEqual(oldAfter, rejectionInverse)
   assert.deepEqual(targetAfter, targetInverse)
   assert.equal(rejectedRow, undefined)
  })
 }
 await check(`issue36/${table}/readable link-forbidden target still resolves`, async () => {
  const id = await call('seedTask', { input: input('native-forbidden-read-' + table, native.forbidden[table]), allowed: true, department: 'A' })
  const row = await rowFor('native-forbidden-read-' + table)
  assert.equal(row._id, id); assert.equal(row[fields[table]]._id, native.forbidden[table])
 })
 for (const kind of ['missing', 'denied', 'otherDepartment']) {
  const absenceName = 'native-absence-' + table + '-' + kind
  await call('seedTask', { input: input(absenceName, native[kind][table]), allowed: true, department: 'A' })
  await check(`issue36/${table}/${kind} one target absence and authorized predicates`, async () => {
   const [row, absent, present, children] = await Promise.all([
    rowFor(absenceName), drain('taskList', { name: absenceName, [fields[table]]: null }),
    drain('taskList', { name: absenceName, not: { [fields[table]]: null } }),
    inverse(table, native[kind][table]),
   ])
   assert.equal(row[fields[table]], null); privateScan(row)
   assert.equal(absent.length, 1)
   assert.deepEqual(present, [])
   assert.deepEqual(children, [])
  })
 }
 // No writes occur until every independent read assertion finishes.
 await Promise.all([
 check(`issue36/${table}/department-B cannot read source or inverse`, async () => {
  const [row, children] = await Promise.all([rowFor(name, carol), inverse(table, target, undefined, carol)])
  assert.equal(row, undefined)
  assert.deepEqual(children, [])
 }),
 check(`issue36/${table}/target-only role cannot inherit task reads`, async () => {
  const [row, children] = await Promise.all([rowFor(name, targetOnly), inverse(table, target, undefined, targetOnly)])
  assert.equal(row, undefined)
  assert.deepEqual(children, [])
 }),
 ])
 await check(`issue36/${table}/source authorization independently rejects target-only and denied task writes`, async () => {
  const [before, deniedBefore] = await Promise.all([call('taskState', { id: task }), call('taskState', { id: deniedSource })])
  await assert.rejects(() => call('updateTask', { id: task, data: { rel: null } }, targetOnly))
  await assert.rejects(() => call('updateTask', { id: deniedSource, data: { rel: target } }))
  const [after, deniedAfter] = await Promise.all([call('taskState', { id: task }), call('taskState', { id: deniedSource })])
  assert.deepEqual(after, before)
  assert.deepEqual(deniedAfter, deniedBefore)
 })
 await call('department', { principal: 'alice', department: 'B' })
 await check(`issue36/${table}/live department change reauthorizes continuation`, async () => assert.deepEqual((await call(endpoint(table), { ...options(first.continueCursor), parent: target })).page, []))
 await call('department', { principal: 'alice', department: 'A' })
 await call('revoke', { principal: 'alice', active: false })
 await check(`issue36/${table}/live membership revocation public root and child absence`, async () => {
  const [row, child] = await Promise.all([rowFor(name), call(endpoint(table), { ...options(first.continueCursor), parent: target })])
  assert.equal(row, undefined)
  assert.deepEqual(child.page, [])
 })
 await check(`issue36/${table}/revoked public command leaves task audit unchanged`, async () => {
  const before = await call('taskState', { id: task })
  await assert.rejects(() => call('updateTask', { id: task, data: { rel: null } }))
  await assert.rejects(() => call('createTask', { input: input('native-revoked-' + table, target) }))
  assert.deepEqual(await call('taskState', { id: task }), before)
 })
 await call('revoke', { principal: 'alice', active: true })
 await check(`issue36/${table}/public relink every member removes old inverse adds new`, async () => {
  await call('updateTask', { id: task, data: { rel: native.targets[otherTable] } })
  const [row, oldChildren, newChildren] = await Promise.all([rowFor(name), inverse(table), inverse(otherTable)])
  assert.equal(row[fields[table]], null)
  assert.equal(row[fields[otherTable]]._id, native.targets[otherTable])
  assert.ok(!oldChildren.some(row => row._id === task))
  assert.ok(newChildren.some(row => row._id === task))
  await call('updateTask', { id: task, data: { rel: target } })
  assert.ok(!(await inverse(otherTable)).some(row => row._id === task))
 })
 await check(`issue36/${table}/omitted link preserves forward inverse and audit intent`, async () => {
  await call('updateTask', { id: task, data: { status: 'done' } })
  const [state, children] = await Promise.all([call('taskState', { id: task }), inverse(table)])
  assert.equal(state.row.rel, target)
  assert.equal(state.audits.at(-1).operation, 'update')
  assert.equal(state.audits.at(-1).next, target)
  assert.ok(children.some(row => row._id === task))
 })
 await check(`issue36/${table}/failure after writes rolls back row inverse audit`, async () => {
  const [before, childrenBefore] = await Promise.all([call('taskState', { id: task }), inverse(table)])
  await assert.rejects(() => call('updateTask', { id: task, data: { rel: null }, failAfterPersist: true }), /TASK_ATOMIC_FAILURE/)
  const [after, childrenAfter] = await Promise.all([call('taskState', { id: task }), inverse(table)])
  assert.deepEqual(after, before)
  assert.deepEqual(childrenAfter, childrenBefore)
 })
 await check(`issue36/${table}/explicit null clears forward inverse with audit`, async () => {
  await call('updateTask', { id: task, data: { rel: null } })
  const [state, row, children] = await Promise.all([call('taskState', { id: task }), rowFor(name), inverse(table)])
  assert.equal(state.row.rel, null); assert.equal(state.audits.at(-1).operation, 'clear')
  assert.equal(state.audits.at(-1).previous, target); assert.equal(state.audits.at(-1).next, null)
  for (const member of members) assert.equal(row[fields[member]], null)
  assert.ok(!children.some(child => child._id === task))
 })
 await call('updateTask', { id: task, data: { rel: target, status: 'open' } })
}
await check('issue36/public root continuation exact authorized inventory no gaps duplicates', async () => {
 const rows = await drain('taskList', { or: members.flatMap(table => [{ name: 'native-link-' + table }, ...[0, 1, 2].map(n => ({ name: 'native-link-' + table + '-child-' + n }))]) }, {}, alice, 32)
 assert.deepEqual(new Set(rows.map(row => row._id)), new Set(Object.values(childIds).flat()))
 assert.equal(rows.length, 32); privateScan(rows)
})
const nativeRootFilters = { or: members.flatMap(table => [{ name: 'native-link-' + table }, ...[0, 1, 2].map(n => ({ name: 'native-link-' + table + '-child-' + n }))]) }
const nativeRootFirst = await call('taskList', options(null, nativeRootFilters))
for (const [axis, args, identity] of [
 ['actor', options(nativeRootFirst.continueCursor, nativeRootFilters), bob],
 ['scope', options(nativeRootFirst.continueCursor, nativeRootFilters), { ...alice, org_id: 'other-scope' }],
 ['filter', options(nativeRootFirst.continueCursor, { status: 'done' }), alice],
 ['order', { ...options(nativeRootFirst.continueCursor, nativeRootFilters), order: 'desc' }, alice],
]) await rejects(`issue36/root cursor rejects ${axis}`, 'taskList', args, identity)
const nativeClientCursor = (await call('inverseClients', { ...options(), parent: native.targets.clients })).continueCursor
await rejects('issue36/cursor rejects changed member declaration registry', 'inverseClientsDeclaration', { ...options(nativeClientCursor), parent: native.targets.clients })
await rejects('issue36/cursor rejects changed policy epoch', 'inverseClientsPolicy', { ...options(nativeClientCursor), parent: native.targets.clients })
await rejects('issue36/root cursor rejects inverse endpoint', 'inverseClients', { ...options(nativeRootFirst.continueCursor, nativeRootFilters), parent: native.targets.clients })
await check('issue36/absent command link and explicit null have matching one absence', async () => {
 const absent = await call('createTask', { input: { name: 'native-omitted', status: 'open' } })
 const cleared = await call('createTask', { input: input('native-null', null) })
 for (const [name, id] of [['native-omitted', absent], ['native-null', cleared]]) {
  const row = await rowFor(name); assert.equal(row._id, id)
  for (const table of members) assert.equal(row[fields[table]], null)
 }
})
await check('issue36/task-only read never inherits client or finance target policy', async () => {
 const [client, payment, ledger, creditor] = await Promise.all([
  rowFor('native-link-clients', taskOnly), rowFor('native-link-payments', taskOnly),
  rowFor('native-link-ledger', reader), rowFor('native-link-creditors', reader),
 ])
 assert.equal(client._id, taskIds.clients); assert.equal(client.client, null)
 assert.equal(payment.payment, null)
 assert.equal(ledger.ledgerEntry, null)
 assert.equal(creditor.creditor, null)
})
await check('issue36/current dependent client policy denies deal and payment despite own allowed flag', async () => {
 for (const [table, id] of [['deals', native.deniedAncestorDeal], ['payments', native.deniedAncestorPayment], ['ledger', native.deniedAncestorLedger]]) {
  const name = 'native-dependent-' + table
  await call('seedTask', { input: input(name, id), allowed: true, department: 'A' })
  assert.equal((await rowFor(name))[fields[table]], null)
  const before = await call('taskState', { id: taskIds[table] }); const childrenBefore = await inverse(table)
  await assert.rejects(() => call('createTask', { input: input(name + '-command', id) }))
  await assert.rejects(() => call('updateTask', { id: taskIds[table], data: { rel: id } }))
  assert.deepEqual(await call('taskState', { id: taskIds[table] }), before)
  assert.deepEqual(await inverse(table), childrenBefore)
 }
})
const financeCursor = (await call('inversePayments', { ...options(), parent: native.targets.payments })).continueCursor
await call('financeMembership', { principal: 'alice', finance: false })
await check('issue36/live finance membership revocation denies targets child cursor and link command', async () => {
 const [payment, ledger, creditor, child] = await Promise.all([
  rowFor('native-link-payments'), rowFor('native-link-ledger'), rowFor('native-link-creditors'),
  call('inversePayments', { ...options(financeCursor), parent: native.targets.payments }),
 ])
 assert.equal(payment.payment, null)
 assert.equal(ledger.ledgerEntry, null)
 assert.equal(creditor.creditor, null)
 assert.deepEqual(child.page, [])
 const before = await call('taskState', { id: taskIds.payments })
 await assert.rejects(() => call('updateTask', { id: taskIds.payments, data: { rel: native.targets.payments } }))
 assert.deepEqual(await call('taskState', { id: taskIds.payments }), before)
})
await call('financeMembership', { principal: 'alice', finance: true })
await check('issue36/ordinary union preserves actual payment ledger variant DTOs and target guards', async () => {
 await call('createTask', { input: input('native-draft-branch', native.draft) })
 await call('createTask', { input: input('native-adjustment-branch', native.adjustment) })
 const [draft, adjustment, payment, ledger, draftInverse, adjustmentInverse] = await Promise.all([
  rowFor('native-draft-branch'), rowFor('native-adjustment-branch'),
  rowFor('native-link-payments'), rowFor('native-link-ledger'),
  inverse('payments', native.draft), inverse('ledger', native.adjustment),
 ])
 assert.equal(draft.payment.type, 'client_draft'); assert.equal(draft.draftPayment.type, 'client_draft')
 assert.equal(payment.draftPayment, null)
 assert.equal(adjustment.ledgerEntry.type, 'adjustment'); assert.equal(adjustment.adjustment.type, 'adjustment')
 assert.equal(ledger.adjustment, null)
 assert.equal(draftInverse[0]._id, draft._id)
 assert.equal(adjustmentInverse[0]._id, adjustment._id)
 privateScan([draft, adjustment])
})
await check('issue36/some none null and logical filters use authorized view', async () => {
 const some = await drain('nativeClients', { name: 'native-client-allowed', tasks: { some: { status: 'open', client: { name: 'native-client-allowed' } } } })
 assert.deepEqual(some.map(row => row._id), [native.targets.clients])
 assert.deepEqual(await drain('nativeClients', { name: 'native-client-allowed', tasks: { none: { status: 'open' } } }), [])
 assert.deepEqual((await drain('nativeClients', { name: 'native-client-forbidden', tasks: { none: { status: 'done' } } })).map(row => row._id), [native.forbidden.clients])
 const matching = await drain('taskList', { and: [{ name: 'native-link-clients' }, { not: { client: null } }, { or: [{ client: { name: 'native-client-allowed' } }, { status: 'done' }] }] })
 assert.deepEqual(matching.map(row => row._id), [taskIds.clients])
 assert.deepEqual(await drain('taskList', { name: 'native-absence-clients-denied', client: { name: 'native-client-denied' } }), [])
})
await check('issue36/nested inverse child page and standalone continuation exact union IDs', async () => {
 const root = await rowFor('native-link-clients')
 const nested = root.client.tasks
 assert.ok(nested.page.length > 0 && nested.page.length <= 3); assert.equal(nested.isDone, false)
 const continued = await call('nestedClientTasks', { ...options(nested.continueCursor), parent: taskIds.clients })
 assert.deepEqual([...nested.page, ...continued.page].map(row => row._id), childIds.clients)
 const first = await call('nativeClients', options(null, { name: 'native-client-allowed' }))
 assert.deepEqual(first.page[0].tasks.page.map(row => row._id), nested.page.map(row => row._id))
})
await check('issue36/task self-member nested inverse continuation', async () => {
 const root = await rowFor('native-link-tasks')
 const nested = root.referenceTask.referencingTasks
 const continued = await call('nestedReferenceTasks', { ...options(nested.continueCursor), parent: taskIds.tasks })
 assert.deepEqual([...nested.page, ...continued.page].map(row => row._id), childIds.tasks)
})
// A two-hop ancestor path must be rechecked even when the signed child token opens.
const ancestor = await call('createTask', { input: input('native-ancestor', native.targets.clients) })
const rootTask = await call('createTask', { input: input('native-deep-root', ancestor) })
const deepRoot = await rowFor('native-deep-root')
const deepChild = deepRoot.referenceTask.client.tasks
await check('issue36/task reference nested deep child continuation', async () => {
 const rows = [...deepChild.page]; let child = deepChild
 for (let n = 0; !child.isDone && n < 8; n++) {
  child = await call('deepTasks', { ...options(child.continueCursor), parent: rootTask })
  rows.push(...child.page)
 }
 assert.equal(child.isDone, true)
 assert.deepEqual(rows.map(row => row._id), [...childIds.clients, ancestor])
 assert.equal(deepRoot.referenceTask._id, ancestor)
 assert.equal(deepChild.isDone, false)
})
await rejects('issue36/deep cursor rejects different ancestor parent', 'deepTasks', { ...options(deepChild.continueCursor), parent: taskIds.tasks })
await call('updateTask', { id: ancestor, data: { rel: native.targets.leads } })
await check('issue36/relinked ancestor cannot resume old child cursor', async () => {
 assert.deepEqual((await call('deepTasks', { ...options(deepChild.continueCursor), parent: rootTask })).page, [])
})
await call('updateTask', { id: ancestor, data: { rel: native.targets.clients } })
await call('revoke', { principal: 'alice', active: false })
await check('issue36/revoked ancestor authority cannot resume deep child cursor', async () => assert.deepEqual((await call('deepTasks', { ...options(deepChild.continueCursor), parent: rootTask })).page, []))
await call('revoke', { principal: 'alice', active: true })
for (const [label, rel] of [['arbitrary-string', 'arbitrary'], ['malformed-id', '!invalid'], ['ninth-table', native.outsider]]) {
 await rejects(`issue36/native command union rejects ${label}`, 'createTask', { input: input('native-invalid-' + label, rel) })
 await rejects(`issue36/native relink union rejects ${label}`, 'updateTask', { id: taskIds.tasks, data: { rel } })
}
await rejects('issue36/native inverse argument rejects wrong allowed table ID', 'inverseClients', { ...options(), parent: native.targets.leads })
await rejects('issue36/private command field cannot bypass generated mask', 'createTask', { input: { ...input('native-private', native.targets.clients), secret: 'injected' } })
await check('issue36/public pages contain only generated DTO fields and opaque cursors', async () => privateScan(publicPages))

await check('issue35/full storage refinements and generated command timestamp masks', async () => assert.deepEqual(await call('timestampContracts'), [true, ...Array(10).fill(false)]))
await check('issue35/required explicit timestamps persisted native row and DTO masks', async () => {
 const [payment, adjustment, hiddenRow, exposedRow] = await Promise.all([
  call('ledgerState', { id: native.targets.ledger }), call('ledgerState', { id: native.adjustment }),
  rowFor('native-link-ledger'), rowFor('native-adjustment-branch'),
 ])
 assert.equal(payment.createdAt, 10); assert.equal(payment.recordedAt, 20)
 assert.equal(adjustment.createdAt, 30); assert.equal(adjustment.recordedAt, 40)
 const hidden = hiddenRow.ledgerEntry
 assert.ok(!('createdAt' in hidden)); assert.ok(!('recordedAt' in hidden))
 const exposed = exposedRow.ledgerEntry
 assert.equal(exposed.createdAt, 30); assert.equal(exposed.recordedAt, 40)
 assert.ok(!('updatedAt' in adjustment)); assert.ok(!('archivedAt' in adjustment))
})
await rejects('issue35/command cannot inject server createdAt', 'updateLedger', { id: native.adjustment, data: { type: 'adjustment', createdAt: 100 } })
await rejects('issue35/command cannot inject server recordedAt', 'updateLedger', { id: native.adjustment, data: { type: 'adjustment', recordedAt: 100 } })
await check('issue35/allowed generated ledger update preserves recordedAt and createdAt', async () => {
 await call('updateLedger', { id: native.adjustment, data: { type: 'adjustment', reason: 'updated' } })
 const row = await call('ledgerState', { id: native.adjustment })
 assert.equal(row.reason, 'updated'); assert.equal(row.createdAt, 30); assert.equal(row.recordedAt, 40)
})
const rawEntry = { type: 'adjustment', reason: 'raw-validator', amountCents: 1, allowed: true, evidence: 'raw-validator-input', createdAt: 1, recordedAt: 2 }
const { createdAt: rawCreatedAt, ...noCreatedAt } = rawEntry
const { recordedAt: rawRecordedAt, ...noRecordedAt } = rawEntry
void rawCreatedAt; void rawRecordedAt
await rejects('issue35/native validator requires createdAt', 'rawLedger', { input: noCreatedAt })
await rejects('issue35/native validator requires recordedAt', 'rawLedger', { input: noRecordedAt })
await rejects('issue35/native validator requires number timestamp', 'rawLedger', { input: { ...rawEntry, createdAt: 'one' } })
await check('issue35/native number shape admits fraction while full storage parser rejects', async () => {
 await call('nativeNumber', { id: native.adjustment, value: 1.5 })
 assert.equal((await call('ledgerState', { id: native.adjustment })).createdAt, 1.5)
 await assert.rejects(() => call('updateLedger', { id: native.adjustment, data: { type: 'adjustment', reason: 'must-not-persist' } }))
 await call('nativeNumber', { id: native.adjustment, value: 30 })
})

const legacyLabels = JSON.parse(readFileSync('legacy-labels.json', 'utf8'))
assert.equal(legacyLabels.length, 52)
for (const label of legacyLabels) assert.ok(evidence.some(result => result.label === label && result.passed), `Missing legacy assertion: ${label}`)
assert.equal(new Set(evidence.map(result => result.label)).size, evidence.length)
assert.ok(evidence.length >= 300, 'Expected all 52 legacy assertions and at least 248 new native assertions')
writeFileSync('native-results.json', JSON.stringify(evidence, null, 2))
saveTimings()
writeFileSync('NATIVE_SUCCESS', `${evidence.length} native assertions passed\n`)
console.log(`Native variant shared-engine passed: ${evidence.length} assertions`)
