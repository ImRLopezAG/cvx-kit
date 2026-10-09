import { execFileSync } from 'node:child_process'
import {
	cpSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-effect-'))
const effectVersion = '4.0.1'
const helpersVersion = '0.1.123'
const nodeTypesVersion = '26.6.1'
const domainGuidePath = join(root, 'src/docs/domain-operations.md')
const domainGuideImports = new Set([
	'./fixture-effect/convex/_generated/api',
	'./fixture-effect/convex/_generated/server',
	'./fixture-effect/convex/idempotency',
	'./fixture-effect/convex/integratedRename',
	'./fixture-effect/convex/_generated/dataModel',
])
const extraTypeFixtures = [
	join(root, 'README.md'),
	join(root, 'src/docs/effect.md'),
	join(root, 'src/docs/commands.md'),
	join(root, 'src/docs/commands-legacy.md'),
	join(root, 'src/docs/auth.md'),
	domainGuidePath,
	...process.argv.slice(2).map((path) => resolve(path)),
]

function run(command, args, cwd) {
	try {
		return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
	} catch (error) {
		// Install output can contain registry credentials. Report compiler/runtime diagnostics only.
		if (!args.includes('install')) {
			process.stderr.write(error.stdout ?? '')
			process.stderr.write(error.stderr ?? '')
		}
		throw new Error(`${command} ${args.join(' ')} failed in ${basename(cwd)}`, {
			cause: error.code,
		})
	}
}

function copyPublicTypeFixture(fixture, filename, publicImport) {
	const source = readFileSync(join(root, 'test', filename), 'utf8')
		.replaceAll(publicImport, 'cvx-kit/effect')
		.replaceAll('../src/errors', 'cvx-kit/errors')
		.replaceAll('../src/contracts', 'cvx-kit/contracts')
		.replaceAll('../src/idempotency', 'cvx-kit/idempotency')
		.replaceAll('../src/modules/contracts/errors', 'cvx-kit/errors')
		.replaceAll('../src/modules/contracts/idempotency', 'cvx-kit/idempotency')
		.replaceAll('../src/modules/contracts/workflow', 'cvx-kit/workflow')
		.replaceAll('../src/modules/contracts/exposure', 'cvx-kit/agent-tools')
		.replaceAll('../src/modules/effect/workflow', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/idempotency', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/foundation', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/schema', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/operation', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/crud', 'cvx-kit/effect')
		.replaceAll('../src/modules/effect/errors', 'cvx-kit/effect')
		.replaceAll('../src/components/foundation/client', 'cvx-kit/components/foundation')
		.replaceAll('../src/crud', 'cvx-kit/crud')
		.replaceAll('../src/zod-table', 'cvx-kit/zod-table')
	if (/from ['"]\.\.\/src\//.test(source))
		throw new Error(`${filename} still uses private source imports`)
	writeFileSync(join(fixture, filename), source)
	return filename
}

// Compile the published guide itself so prose edits cannot leave stale companion fixtures passing.
function publishedTypeSources(path, contents) {
	if (!path.endsWith('.md')) return [contents]
	const marked = [
		...contents.matchAll(/<!-- packed-effect-example -->\s*```ts\s*\n([\s\S]*?)^```/gm),
	]
	if (marked.length) return marked.map((match) => match[1])
	return [[...contents.matchAll(/^```ts\s*\n([\s\S]*?)^```/gm)].map((match) => match[1]).join('\n')]
}

function copyExtraTypeFixtures(fixture, paths) {
	return paths.flatMap((path, index) => {
		const contents = readFileSync(path, 'utf8')
		const sources = publishedTypeSources(path, contents)
		const isDomainGuide = path === domainGuidePath
		if (isDomainGuide) {
			const companion = readFileSync(join(root, 'test/domain-operation-guide-types.ts'), 'utf8')
			const blocks = [...contents.matchAll(/^```ts\s*\n([\s\S]*?)^```/gm)]
			if (blocks.length !== 1 || sources.length !== 1 || sources[0].trim() !== companion.trim())
				throw new Error(
					'Domain operation guide must contain its complete, current companion fixture',
				)
			cpSync(join(root, 'test/fixture-effect/convex'), join(fixture, 'fixture-effect/convex'), {
				recursive: true,
			})
		}
		return sources.map((source, snippet) => {
			if (!source.trim())
				throw new Error(`Documentation fixture ${basename(path)} has no TypeScript`)
			const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1])
			if (
				imports.some(
					(specifier) =>
						/^cvx-kit\/(?:src|dist)\//.test(specifier) ||
						(/^\.\.?\//.test(specifier) && !(isDomainGuide && domainGuideImports.has(specifier))),
				)
			) {
				throw new Error(`Documentation fixture ${basename(path)} must use public package imports`)
			}
			const filename = isDomainGuide
				? `domain-operation-guide-${snippet}.ts`
				: `doc-example-${index}-${snippet}.ts`
			writeFileSync(join(fixture, filename), source)
			return filename
		})
	})
}

const legacyRuntime = `
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { Foundation } from 'cvx-kit/components/foundation'
import { Foundation as RootFoundation } from 'cvx-kit'
import { createAuthFunctions, defaultRoleMap } from 'cvx-kit/auth'
import { createCrudCommands } from 'cvx-kit/crud'
import { zodTable } from 'cvx-kit/zod-table'
import { decodeContract, standardContract, zodContract } from 'cvx-kit/contracts'
import { captureIdempotencyInvocation, transactionalIdempotency, canonicalConvexBytes } from 'cvx-kit/idempotency'
import { defineErrorContract } from 'cvx-kit/errors'
import { workflowTransition } from 'cvx-kit/workflow'
import { selectOperation, bindOperationExecutor, createOperationTools, operationToolDialect } from 'cvx-kit/agent-tools'
import { actionGeneric, queryGeneric, mutationGeneric, internalActionGeneric, internalQueryGeneric, internalMutationGeneric } from 'convex/server'
import { z } from 'zod'
const require = createRequire(import.meta.url)
if (process.argv.includes('--without-effect')) {
 assert.throws(() => require.resolve('effect'), { code: 'MODULE_NOT_FOUND' }, 'optional peer was unexpectedly auto-installed')
}
assert.equal(RootFoundation, Foundation)
assert.equal(typeof workflowTransition, 'function')
const toolOwner = Symbol('packed-tools')
const toolSelection = selectOperation(toolOwner, 'query', 'measure', { input: z.object({ title: z.string() }), result: z.number() })
const toolExecutor = bindOperationExecutor(toolSelection, { owner: toolOwner, key: 'measure', execute: async raw => raw.title.length })
const operationTools = createOperationTools({ measure: { operation: toolSelection, executor: toolExecutor, description: 'Measure a title', converter: { dialect: operationToolDialect, convert: () => ({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }) } } })
assert.deepEqual(await operationTools.measure.invoke({ title: 'packed' }), { _tag: 'Success', value: 6 })
let normalizations = 0
const normalized = zodContract(z.string().transform(async value => { normalizations++; return value.trim() }))
assert.deepEqual(await decodeContract(normalized, ' packed '), { value: 'packed' })
assert.equal(normalizations, 1)
const receiverSchema = { '~standard': {
 version: 1, vendor: 'packed-receiver',
 validate(value) { return this.vendor === 'packed-receiver' ? { value } : { issues: [{ message: 'lost receiver' }] } },
} }
assert.deepEqual(await decodeContract(receiverSchema, 'packed'), { value: 'packed' })
assert.deepEqual(await decodeContract(standardContract(receiverSchema), 'packed'), { value: 'packed' })
const errors = defineErrorContract({ DENIED: { message: 'Denied', details: { key: z.string() } } })
const envelope = errors.project(errors.create('DENIED', { key: 'packed' }))
assert.deepEqual(errors.decode(JSON.parse(JSON.stringify(envelope))), envelope)
const audits = []
const { Command } = new Foundation({ functions: { status: null } }, {
 observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }), writeAudit: (_ctx, entry) => audits.push(entry) },
})
const operations = { measure: Command.operation({
 command: z.object({ title: z.string().transform(value => value.length) }), result: z.number(),
 classification: 'business', audit: () => null,
}) }
const execute = new Command(operations).exec({ operation: 'measure', handler: async (ctx, input) => ctx.offset + input.title })
const pending = execute({ offset: 2 }, { title: 'abc' })
assert.ok(pending instanceof Promise)
assert.equal(await pending, 5)
assert.equal(defaultRoleMap('member'), 'writer')
const auth = createAuthFunctions({
 query: queryGeneric, mutation: mutationGeneric, action: actionGeneric,
 internalQuery: internalQueryGeneric, internalMutation: internalMutationGeneric, internalAction: internalActionGeneric,
 getAuthUser: async () => ({ id: 'actor' }), mapRole: defaultRoleMap, adminRoles: ['admin'],
})
const authenticated = auth.authQuery({ args: {}, returns: z.string(), handler: ctx => ctx.actor.userId + ':' + ctx.tenant })
assert.equal(await authenticated._handler({ auth: { getUserIdentity: async () => ({ subject: 'actor', org_id: 'org', role: 'member' }) }, db: {} }, {}), 'actor:org')
const table = zodTable('notes', () => ({ text: z.string() }), { commandFields: ['text'] })
const crud = createCrudCommands({ Command, table, aggregateType: 'note', actor: () => 'actor' })
const changes = []
const ctx = { db: { insert: async (name, row) => { changes.push([name, row]); return 'note-id' }, patch: async (id, row) => changes.push([id, row]) } }
assert.deepEqual(await crud.executeCreate(ctx, { text: 'packed' }), { id: 'note-id' })
assert.deepEqual(await crud.executeUpdate(ctx, { id: 'note-id', data: { text: 'updated' } }), { ok: true })
assert.deepEqual(changes, [['notes', { text: 'packed' }], ['note-id', { text: 'updated' }]])
assert.equal(audits.length, 2)
const bounds = { maxDepth: 8, maxNodes: 100, maxBytes: 4096, maxArrayLength: 20, maxObjectFields: 20 }
assert.equal(canonicalConvexBytes({ b: { d: 2, c: 1 }, a: 0 }, bounds), canonicalConvexBytes({ a: 0, b: { c: 1, d: 2 } }, bounds))
const invocation = captureIdempotencyInvocation({ binding: { kind: 'mutation', atomicity: 'same-mutation' }, identity: { operation: 'packed', scope: 'host', key: 'one' }, versions: { operation: '1', contract: '1', binding: '1', fingerprintPolicy: '1' }, rawInput: { title: 'raw' }, canonical: { bounds } })
const ledger = []
let authorizations = 0
const idempotency = transactionalIdempotency({
 final: { replayResult: zodContract(z.object({ version: z.literal(1), value: z.string() }).transform(wire => wire.value)), encode: value => ({ version: 1, value }) },
 authorize: () => { authorizations++ }, lookup: () => ledger, fingerprint: bytes => bytes,
 claim: (_identity, receipt) => { ledger.push(receipt); return 0 }, complete: (index, receipt) => { ledger[index] = receipt },
})
const preparation = await idempotency.prepare(invocation)
assert.equal(preparation.kind, 'execute')
await preparation.complete('final!')
const replay = await idempotency.prepare(invocation)
assert.equal(replay.kind, 'replay')
assert.deepEqual(await decodeContract(idempotency.replayResult, replay.result), { value: 'final!' })
assert.equal(authorizations, 2)
assert.equal(ledger.length, 1)
`

const legacyTypes = `
import { Foundation } from 'cvx-kit'
import { createAuthFunctions, defaultRoleMap } from 'cvx-kit/auth'
import { createCrudCommands } from 'cvx-kit/crud'
import { zodTable } from 'cvx-kit/zod-table'
import { actionGeneric, queryGeneric, mutationGeneric, internalActionGeneric, internalQueryGeneric, internalMutationGeneric, type GenericMutationCtx, type GenericDataModel } from 'convex/server'
import { z } from 'zod'
const { Command } = new Foundation({ functions: { status: null } }, {
 observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }) },
})
const operation = Command.withContext<{ offset: number }>().operation({
 command: z.object({ title: z.string().transform(value => value.length) }), result: z.number(), classification: 'business', audit: () => null,
})
const commands = new Command<{ offset: number }, { measure: typeof operation }>({ measure: operation })
const execute = commands.exec({ operation: 'measure', handler: async (ctx, input) => ctx.offset + input.title })
const result: Promise<number> = execute({ offset: 1 }, { title: 'raw' })
void result
const auth = createAuthFunctions({ query: queryGeneric, mutation: mutationGeneric, action: actionGeneric,
 internalQuery: internalQueryGeneric, internalMutation: internalMutationGeneric, internalAction: internalActionGeneric,
 getAuthUser: async () => ({ id: 'actor' }), mapRole: defaultRoleMap, adminRoles: ['admin'],
})
const authenticated = auth.authQuery({ args: {}, returns: z.string(), handler: ctx => ctx.actor.userId })
void authenticated
const table = zodTable('notes', () => ({ text: z.string() }), { commandFields: ['text'] })
const crud = createCrudCommands<GenericMutationCtx<GenericDataModel>, typeof table>({ Command, table, aggregateType: 'note', actor: () => 'actor' })
declare const ctx: GenericMutationCtx<GenericDataModel>
void crud.executeCreate(ctx, { text: 'packed' })
`

const domainTypes = `
import { Context, Effect } from 'effect'
import { createEffectFoundation } from 'cvx-kit/effect'
import { z } from 'zod'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
class Reader extends Context.Service<Reader, { count: number }>()('PackedReader') {}
class Failure { readonly _tag = 'PackedFailure' }
const foundation = createEffectFoundation({ observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }) }, writeAudit: () => undefined })
const queries = foundation.Query({ context: (host: { actor: string }) => host, operations: ({ query }) => ({
 read: query({ input: z.string().transform(value => value.length), result: z.number().transform(String),
  handler: (input, ctx) => Effect.gen(function* () { ctx.actor.toUpperCase(); if (input < 1) return yield* Effect.fail(new Failure()); return input + (yield* Reader).count }),
 }),
 recovered: query({ input: z.number(), result: z.number(), handler: input => Effect.gen(function* () { if (input < 0) return yield* Effect.fail(new Failure()); return input + (yield* Reader).count }),
  middleware: ({ next }) => next().pipe(Effect.provideService(Reader, { count: 1 }), Effect.catchTag('PackedFailure', () => Effect.succeed(0))),
 }),
 ordinary: query({ input: z.number(), result: z.number(), handler: input => input }),
 promise: query({ input: z.number(), result: z.number(), handler: async input => input }),
 named: query({ input: z.number(), result: z.number(), handler: Effect.fn('packed.named')(function* (input: number) { return yield* Effect.succeed(input) }) }),
}) })
const read = queries.exec('read', 'raw', { actor: 'trusted' })
const recovered = queries.exec('recovered', 1, { actor: 'trusted' })
const checks: [Assert<Equal<Effect.Success<typeof read>, string>>, Assert<Equal<Effect.Error<typeof read>, Failure>>, Assert<Equal<Effect.Services<typeof read>, Reader>>, Assert<Equal<Effect.Error<typeof recovered>, never>>, Assert<Equal<Effect.Services<typeof recovered>, never>>] = [true, true, true, true, true]
void checks
// @ts-expect-error an unprovided domain requirement cannot reach the runner
void Effect.runPromise(read)
// @ts-expect-error transport input is the raw schema input
queries.exec('read', 1, { actor: 'trusted' })
for (const kind of ['ordinary', 'promise', 'named'] as const) { const execution = queries.exec(kind, 1, { actor: 'trusted' }); const checks: [Assert<Equal<Effect.Error<typeof execution>, never>>, Assert<Equal<Effect.Services<typeof execution>, never>>] = [true, true]; void checks }
`

const effectRuntime = `
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { Context, Effect } from 'effect'
import { createEffectFoundation, createEffectCrud, effectApiBuilder, effectZodApiBuilder, createOperationTools } from 'cvx-kit/effect'
import { createOperationTools as neutralOperationTools } from 'cvx-kit/agent-tools'
import { zodTable } from 'cvx-kit/zod-table'
import { queryGeneric, internalMutationGeneric, actionGeneric } from 'convex/server'
import { zCustomMutation } from 'convex-helpers/server/zod4'
import { v } from 'convex/values'
import { z } from 'zod'
const require = createRequire(import.meta.url)
const packageRequire = createRequire(import.meta.resolve('cvx-kit/effect'))
assert.equal(createOperationTools, neutralOperationTools)
assert.equal(realpathSync(require.resolve('effect')), realpathSync(packageRequire.resolve('effect')), 'package resolved a second Effect identity')
class Request extends Context.Service()('PackedRequest') {}
const events = []
const foundation = createEffectFoundation({ observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }) }, writeAudit: () => events.push('audit') })
const queries = foundation.Query({ context: host => host, operations: ({ query }) => ({
 read: query({ input: z.string().transform(value => value.length), result: z.number(), handler: input => Effect.gen(function* () { events.push('read'); return input + (yield* Request).offset }) }),
}) })
const commands = foundation.Command({ context: host => host, operations: ({ command }) => ({
 save: command({ input: z.string(), result: z.number(), classification: 'business', audit: () => ({ operation: 'save', actorId: 'actor', aggregate: { type: 'note', id: 'note-id' } }), handler: (input, host) => Effect.gen(function* () { events.push('save'); return yield* queries.exec('read', input, host) }) }),
}) })
const execution = commands.exec('save', 'abc', {})
assert.ok(Effect.isEffect(execution), 'public facade must return the host Effect value')
assert.deepEqual(events, [], 'domain composition must stay lazy')
const adapted = effectApiBuilder(queryGeneric, { services: () => { events.push('provide'); return Context.make(Request, { offset: 2 }) } })({ args: {}, returns: v.number(), handler: () => execution })
assert.equal(await adapted._handler({}, {}), 5)
assert.deepEqual(events, ['provide', 'save', 'read', 'audit'], 'one adapter run must execute nested composition once')
const plain = effectApiBuilder(queryGeneric, { services: () => Context.empty() })
for (const handler of [() => 3, () => Promise.resolve(3), () => Effect.succeed(3), Effect.fn('packed.fn')(function* () { return yield* Effect.succeed(3) })]) {
 assert.equal(await plain({ handler })._handler({}, {}), 3)
}
const customization = []
const custom = effectZodApiBuilder(zCustomMutation(internalMutationGeneric, { args: { session: v.string() }, input: (_ctx, args) => { customization.push('custom'); return { ctx: { actor: args.session }, args: { made: 4 } } } }), {
 services: ctx => { customization.push('provide:' + ctx.actor); return Context.make(Request, { offset: 2 }) },
})({ args: { amount: z.string().transform(value => value.length) }, returns: z.number().transform(String), skipConvexValidation: true,
 handler: (ctx, args) => Effect.gen(function* () { customization.push('handle:' + ctx.actor); return args.amount + args.made + (yield* Request).offset }),
})
assert.equal(await custom._handler({}, { session: 'trusted', amount: 'abc' }), '9')
assert.deepEqual(customization, ['custom', 'provide:trusted', 'handle:trusted'])
assert.ok(custom.isInternal && custom.isMutation)
assert.ok(effectApiBuilder(actionGeneric, { services: () => Context.empty() })(() => 1).isAction)
for (const fail of [false, true]) {
 const lifecycle = []
 const adapter = effectApiBuilder(queryGeneric, { services: () => Effect.acquireRelease(Effect.sync(() => { lifecycle.push('acquire'); return Context.empty() }), () => Effect.promise(async () => { await Promise.resolve(); lifecycle.push('release') })) })
 const registered = adapter({ handler: () => Effect.gen(function* () { lifecycle.push('handle'); if (fail) return yield* Effect.fail('packed-failure'); return 1 }) })
 if (fail) await assert.rejects(registered._handler({}, {}), error => error === 'packed-failure')
 else assert.equal(await registered._handler({}, {}), 1)
 assert.deepEqual(lifecycle, ['acquire', 'handle', 'release'])
}
await assert.rejects(plain({ handler: () => Effect.die(new Error('packed-defect')) })._handler({}, {}), /packed-defect/)
await assert.rejects(plain({ handler: () => Effect.interrupt })._handler({}, {}))
const crudAudits = []
const crudFoundation = createEffectFoundation({ observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }) }, writeAudit: (_host, entry) => crudAudits.push(entry) })
const crudTable = zodTable('packedNotes', () => ({ title: z.string(), secret: z.string() }), { commandFields: ['title'], serverFields: ['secret'], publicFields: ['title'] })
let crudRow
const crudHost = { actor: 'packed-actor', db: { insert: async (_table, values) => { crudRow = values; return 'packed-id' }, patch: async (_id, values) => { crudRow = { ...crudRow, ...values } } } }
const crud = createEffectCrud({ foundation: crudFoundation, table: crudTable, context: host => host, aggregateType: 'note', actor: host => host.actor, checkId: (_host, id) => id === 'packed-id', enrich: () => ({ secret: 'private' }), read: { maxPageSize: 2, project: row => ({ title: row.title }), get: () => crudRow ?? null, list: () => ({ page: crudRow ? [crudRow] : [], isDone: true, continueCursor: '' }) } })
const pendingCreate = crud.commands.exec('packedNotes.create', { title: 'packed-crud' }, crudHost)
assert.equal(crudRow, undefined, 'CRUD remains lazy before the API runner')
assert.deepEqual(await Effect.runPromise(pendingCreate), { id: 'packed-id' })
assert.deepEqual(await Effect.runPromise(crud.queries.exec('packedNotes.get', { id: 'packed-id' }, crudHost)), { title: 'packed-crud' })
assert.deepEqual(await Effect.runPromise(crud.commands.exec('packedNotes.update', { id: 'packed-id', data: {} }, crudHost)), { ok: true })
assert.equal(crudAudits.length, 2)
assert.deepEqual(crudRow, { title: 'packed-crud', secret: 'private' })
assert.deepEqual(await Effect.runPromise(crud.commands.exec('packedNotes.update', { id: 'packed-id', data: { title: 'packed-updated' } }, crudHost)), { ok: true })
assert.deepEqual(crudRow, { title: 'packed-updated', secret: 'private' })
assert.deepEqual(await Effect.runPromise(crud.queries.exec('packedNotes.get', { id: 'packed-id' }, crudHost)), { title: 'packed-updated' })
assert.equal(crudAudits.length, 3)
assert.deepEqual(crudAudits.map(entry => entry.operation), ['packedNotes.create', 'packedNotes.update', 'packedNotes.update'])
for (const [registry, operation, input] of [
 [crud.queries, 'packedNotes.get', { id: 'other-table-id' }],
 [crud.commands, 'packedNotes.update', { id: 'other-table-id', data: { title: 'wrong-table' } }],
 [crud.commands, 'packedNotes.archive', { id: 'other-table-id' }],
]) {
 await assert.rejects(Effect.runPromise(registry.exec(operation, input, crudHost)), error => error.code === 'CRUD_INVALID_ID')
 assert.deepEqual(crudRow, { title: 'packed-updated', secret: 'private' })
 assert.equal(crudAudits.length, 3)
}
`

try {
	run('bun', ['pm', 'pack', '--destination', temporary, '--ignore-scripts'], root)
	for (const installer of ['npm', 'bun']) {
		for (const withEffect of [false, true]) {
			const name = `${installer}-${withEffect ? 'effect' : 'legacy'}`
			const fixture = join(temporary, name)
			mkdirSync(fixture)
			const dependencies = {
				'cvx-kit': `file:${join(temporary, `cvx-kit-${manifest.version}.tgz`)}`,
				convex: manifest.devDependencies.convex,
				'convex-helpers': helpersVersion,
				'@convex-dev/workflow': manifest.dependencies['@convex-dev/workflow'],
				zod: manifest.devDependencies.zod,
			}
			if (withEffect) dependencies.effect = effectVersion
			const devDependencies = { typescript: manifest.devDependencies.typescript }
			if (withEffect) devDependencies['@types/node'] = nodeTypesVersion
			writeFileSync(
				join(fixture, 'package.json'),
				JSON.stringify({
					private: true,
					type: 'module',
					dependencies,
					devDependencies,
				}),
			)
			run(installer, ['install', '--ignore-scripts'], fixture)
			writeFileSync(join(fixture, 'legacy.mjs'), legacyRuntime)
			writeFileSync(join(fixture, 'legacy-types.ts'), legacyTypes)
			const typeFiles = [
				'legacy-types.ts',
				copyPublicTypeFixture(fixture, 'operation-neutral-types.ts', '../src/effect'),
				copyPublicTypeFixture(fixture, 'operation-agent-tools-types.ts', '../src/effect'),
			]
			const guideTypeFiles = []
			if (withEffect) {
				for (const filename of [
					'effect-foundation-types.ts',
					'effect-api-types.ts',
					'effect-api-zod-types.ts',
					'effect-registry-review-types.ts',
					'operation-contract-types.ts',
					'effect-schema-types.ts',
					'effect-crud-types.ts',
					'idempotency-types.ts',
					'operation-workflow-types.ts',
					'error-contract-types.ts',
				]) {
					typeFiles.push(copyPublicTypeFixture(fixture, filename, '../src/effect'))
				}
				writeFileSync(join(fixture, 'domain-types.ts'), domainTypes)
				writeFileSync(join(fixture, 'effect.mjs'), effectRuntime)
				typeFiles.push('domain-types.ts')
				for (const filename of copyExtraTypeFixtures(fixture, extraTypeFixtures)) {
					if (filename.startsWith('domain-operation-guide-')) guideTypeFiles.push(filename)
					else typeFiles.push(filename)
				}
			}
			writeFileSync(
				join(fixture, 'tsconfig.json'),
				JSON.stringify({
					compilerOptions: {
						noEmit: true,
						strict: true,
						skipLibCheck: false,
						target: 'ES2025',
						lib: ['ES2025', 'DOM', 'ESNext.Disposable'],
						module: 'ESNext',
						moduleResolution: 'Bundler',
						types: [],
					},
					files: typeFiles,
				}),
			)
			const compiler = realpathSync(join(fixture, 'node_modules/typescript/bin/tsc'))
			run('node', [compiler, '-p', 'tsconfig.json'], fixture)
			if (withEffect) {
				writeFileSync(
					join(fixture, 'tsconfig.domain.json'),
					JSON.stringify({
						extends: './tsconfig.json',
						compilerOptions: { types: ['node'] },
						files: guideTypeFiles,
					}),
				)
				run('node', [compiler, '-p', 'tsconfig.domain.json'], fixture)
				console.log(`${name}: complete domain guide and actual native references pass separately`)
			}
			console.log(
				`${name}: strict public declaration/type fixtures pass (TypeScript ${manifest.devDependencies.typescript}, helpers ${helpersVersion})`,
			)
			const runtime = installer === 'bun' ? 'bun' : 'node'
			run(runtime, ['legacy.mjs', ...(withEffect ? [] : ['--without-effect'])], fixture)
			if (withEffect) run(runtime, ['effect.mjs'], fixture)
			console.log(
				`${name}: public consumer runtime pass (Convex ${manifest.devDependencies.convex}, Zod ${manifest.devDependencies.zod}${withEffect ? `, Effect ${effectVersion}` : ', Effect absent'})`,
			)
		}
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
