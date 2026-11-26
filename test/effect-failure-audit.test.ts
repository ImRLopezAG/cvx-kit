/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Failure fixtures deliberately throw untyped values and drive erased hosts. */
import { Cause, Effect, Exit, Schema } from 'effect'
import { convexTest } from 'convex-test'
import {
	actionGeneric,
	defineSchema,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	defineTable,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
	type MutationBuilder,
} from 'convex/server'
import { ConvexError, v, type Value } from 'convex/values'
import { describe, expect, it, vi } from 'vite-plus/test'
import { k } from '../src/k'
import {
	ARGUMENT_ISSUE_LIMITS,
	argumentErrors,
	combineErrorContracts,
	decodeFailure,
	defineErrorContract,
	failureOf,
	type ArgumentFailurePolicy,
} from '../src/errors'
import type { StandardSchema } from '../src/modules/contracts/contract'
import { defineDomainContract } from '../src/modules/contracts/domain'
import { kContract } from '../src/modules/contracts/standard'
import { KValidationError } from '../src/k/issues'
import { createEffectAuthFunctions } from '../src/modules/effect/auth'
import { effectApiBuilder } from '../src/modules/effect/api'
import { projectErrorCause } from '../src/modules/effect/errors'
import { createEffectFoundation } from '../src/modules/effect/foundation'
import { effectContract, effectSchema } from '../src/modules/effect/schema'
import type { FailureAuditEntry, FailureAuditOptions } from '../src/modules/effect/failure-audit'

const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
const nativeMutation: MutationBuilder<
	DataModelFromSchemaDefinition<typeof schema>,
	'public'
> = mutationGeneric

const notesErrors = defineErrorContract({
	NOT_FOUND: { message: 'Note not found', details: {} },
	LOCKED: {
		message: 'Note locked',
		details: { owner: { parse: (value: unknown) => k.string().parse(value) } },
	},
})
const tenancyErrors = defineErrorContract({
	TENANT_MISSING: { message: 'Tenant missing', details: {} },
})
type Failure = 'declared' | 'thrown' | 'defect' | 'spoofed' | 'locked'

function setup(options: Partial<FailureAuditOptions> & { emitFails?: boolean } = {}) {
	const entries: FailureAuditEntry[] = []
	const foundation = createEffectFoundation({
		observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
		writeAudit: () => undefined,
		auditFailure: {
			...options,
			emit: (entry) => {
				if (options.emitFails) throw Error('sink down')
				entries.push(entry)
			},
		},
	})
	const tenancy = foundation.Query({
		contract: defineDomainContract({
			errors: tenancyErrors,
			queries: { 'tenancy.require': { input: k.string(), result: k.string() } },
		}),
		context: () => ({}),
		operations: ({ query }) => ({
			'tenancy.require': query.handler(() =>
				Effect.fail(tenancyErrors.create('TENANT_MISSING', {})),
			),
		}),
	})
	const notes = foundation.Command({
		contract: defineDomainContract({
			errors: notesErrors,
			commands: {
				'notes.save': {
					input: k.object({ failure: k.string(), secret: k.string() }),
					result: k.string(),
					classification: 'business',
				},
				'notes.tenant': {
					input: k.object({ recover: k.boolean() }),
					result: k.string(),
					classification: 'business',
				},
			},
		}),
		context: (host: Host) => ({ host, tenancy: tenancy.withContext(undefined) }),
		audit: () => null,
		operations: ({ command }) => ({
			'notes.save': command.handler((input, ctx) =>
				Effect.gen(function* () {
					yield* Effect.promise(() => ctx.host.db.insert('writes', { kind: 'note' }))
					const failure = input.failure as Failure
					if (failure === 'declared') return yield* Effect.fail(notesErrors.create('NOT_FOUND', {}))
					if (failure === 'locked')
						return yield* Effect.fail(notesErrors.create('LOCKED', { owner: 'ada@example.com' }))
					if (failure === 'thrown') throw notesErrors.create('NOT_FOUND', {})
					if (failure === 'spoofed') throw { _tag: 'DeclaredError', code: 'NOT_FOUND', details: {} }
					throw Error(`secret ${input.secret}`)
				}),
			),
			'notes.tenant': command.handler((input, ctx) => {
				const required = ctx.tenancy.exec('tenancy.require', 'x')
				return input.recover
					? required.pipe(Effect.catchTag('DeclaredError', () => Effect.succeed('recovered')))
					: required
			}),
		}),
	})
	return { notes, entries }
}

async function runSave(h: ReturnType<typeof setup>, failure: Failure) {
	const t = convexTest(schema, modules)
	const exit = await t
		.mutation((host) =>
			Effect.runPromiseExit(h.notes.exec('notes.save', { failure, secret: 'hunter2' }, host)).then(
				(result) => {
					if (Exit.isFailure(result)) throw result
					return result
				},
			),
		)
		.catch((error: unknown) => error)
	expect(await t.run((ctx) => ctx.db.query('writes').collect())).toEqual([])
	return exit
}

describe('failure audit', () => {
	it('reports a declared failure without details and rolls back the mutation', async () => {
		const h = setup()
		await runSave(h, 'declared')
		expect(h.entries).toEqual([
			{
				kind: 'command',
				operation: 'notes.save',
				classification: 'business',
				errorCode: 'NOT_FOUND',
				declared: true,
				root: 'notes.save',
				depth: 0,
			},
		])
	})

	it('includes details and input only through redactors', async () => {
		const h = setup({
			details: (_details, code) => (code === 'LOCKED' ? { redacted: true } : undefined),
			input: (input) => ({ keys: Object.keys(input as object).sort() }),
		})
		await runSave(h, 'locked')
		expect(h.entries).toEqual([
			expect.objectContaining({
				errorCode: 'LOCKED',
				details: { redacted: true },
				input: { keys: ['failure', 'secret'] },
			}),
		])
		expect(JSON.stringify(h.entries)).not.toContain('ada@example.com')
		expect(JSON.stringify(h.entries)).not.toContain('hunter2')
	})

	it('omits fields whose redactor throws or returns a non-record', async () => {
		const h = setup({
			details: () => {
				throw Error('redactor bug')
			},
			input: () => ['not', 'a', 'record'] as never,
		})
		await runSave(h, 'locked')
		expect(h.entries).toHaveLength(1)
		expect(h.entries[0]).not.toHaveProperty('details')
		expect(h.entries[0]).not.toHaveProperty('input')
	})

	it('keeps the code of a declared error thrown inside Effect.gen', async () => {
		const h = setup()
		await runSave(h, 'thrown')
		expect(h.entries).toEqual([expect.objectContaining({ errorCode: 'NOT_FOUND', declared: true })])
	})

	it('reports defects and spoofed errors as unknown without their message', async () => {
		for (const failure of ['defect', 'spoofed'] as const) {
			const h = setup()
			await runSave(h, failure)
			expect(h.entries).toEqual([
				expect.objectContaining({ errorCode: 'UNKNOWN_FAILURE', declared: false }),
			])
			expect(JSON.stringify(h.entries)).not.toContain('hunter2')
		}
	})

	it('preserves the original failure when the sink throws', async () => {
		const h = setup({ emitFails: true })
		const exit = await Effect.runPromiseExit(
			h.notes.exec('notes.save', { failure: 'declared', secret: 's' }, {
				db: { insert: async () => 'id' },
			} as never),
		)
		if (Exit.isSuccess(exit)) throw Error('expected failure')
		expect(projectErrorCause(notesErrors, exit.cause)).toMatchObject({ code: 'NOT_FOUND' })
	})

	it('reports a nested failure once, with the nested contract code, and keeps recovered failures', async () => {
		for (const recover of [false, true]) {
			const h = setup()
			const exit = await Effect.runPromiseExit(
				h.notes.exec('notes.tenant', { recover }, {} as never),
			)
			expect(Exit.isSuccess(exit)).toBe(recover)
			expect(h.entries).toEqual([
				expect.objectContaining({
					kind: 'query',
					operation: 'tenancy.require',
					errorCode: 'TENANT_MISSING',
					root: 'notes.tenant',
					depth: 1,
				}),
			])
		}
	})

	it('projects inline registries through the fallback contract', async () => {
		const entries: FailureAuditEntry[] = []
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'F' }),
			},
			writeAudit: () => undefined,
			auditFailure: {
				errors: combineErrorContracts(tenancyErrors, notesErrors),
				emit: (entry) => {
					entries.push(entry)
				},
			},
		})
		const inline = foundation.Command({
			context: () => ({}),
			operations: ({ command }) => ({
				'inline.fail': command({
					input: k.number(),
					result: k.number(),
					classification: 'business',
					audit: () => null,
					handler: () => Effect.fail(notesErrors.create('NOT_FOUND', {})),
				}),
			}),
		})
		await Effect.runPromiseExit(inline.exec('inline.fail', 1, undefined))
		expect(entries).toEqual([expect.objectContaining({ errorCode: 'NOT_FOUND', declared: true })])
	})
})

// Convex intentionally omits this runtime field from its public registration declarations.
function invoke<Ctx, Args>(registered: { isConvexFunction: true }, ctx: Ctx, args: Args) {
	// SAFETY: every argument comes from a Convex builder, which retains its runtime _handler field.
	return (
		registered as { isConvexFunction: true; _handler: (ctx: Ctx, args: Args) => Promise<string> }
	)._handler(ctx, args)
}

describe('declared defects at the API boundary', () => {
	it('projects a thrown declared error to its declared failure and spoofs to unknown', async () => {
		for (const spoofed of [false, true]) {
			const t = convexTest(schema, modules)
			const mutation = effectApiBuilder(nativeMutation, { errors: notesErrors })
			const registered = mutation({
				handler: () =>
					Effect.gen(function* () {
						yield* Effect.void
						if (spoofed) throw { _tag: 'DeclaredError', code: 'NOT_FOUND', details: {} }
						throw notesErrors.create('NOT_FOUND', {})
					}),
			})
			const error = await t
				.mutation((ctx) => invoke(registered, ctx, {}))
				.catch((rejected: unknown) => rejected)
			expect(error).toBeInstanceOf(ConvexError)
			expect((error as ConvexError<string>).data).toEqual(
				spoofed
					? { _tag: 'UnknownFailure', version: 1 }
					: {
							_tag: 'DeclaredFailure',
							version: 1,
							code: 'NOT_FOUND',
							message: 'Note not found',
							details: {},
						},
			)
		}
	})
})

const invalidInput = { secret: 'private-rejected-value' }
const argumentContracts = combineErrorContracts(notesErrors, argumentErrors)
const neutralInput: StandardSchema<string> = {
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: () => ({
			issues: Array.from({ length: ARGUMENT_ISSUE_LIMITS.issues + 1 }, () => ({
				path: [{ key: 'nested' }, 0],
				message: 'Invalid input',
				input: invalidInput.secret,
			})),
		}),
	},
}

function argumentHarness(argumentFailure?: ArgumentFailurePolicy) {
	const entries: FailureAuditEntry[] = []
	const foundation = createEffectFoundation({
		argumentFailure,
		observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'F' }) },
		writeAudit: () => undefined,
		auditFailure: {
			emit: (entry) => {
				entries.push(entry)
			},
			details: (details) => ({ details: JSON.stringify(details) }),
			input: (input) => ({ input: JSON.stringify(input) }),
		},
	})
	const contract = defineDomainContract({
		errors: notesErrors,
		commands: {
			save: {
				input: k.object({ secret: k.number() }),
				result: k.string(),
				classification: 'business',
			},
		},
		queries: {
			read: { input: effectSchema(Schema.Struct({ secret: Schema.Number })), result: k.string() },
			neutral: { input: neutralInput, result: k.string() },
			adaptedZod: { input: kContract(k.string().min(5)), result: k.string() },
			invalidResult: { input: k.object({}), result: k.string().min(10) },
			nested: { input: k.object({}), result: k.string() },
			decoderFailure: {
				input: effectContract(() => Effect.fail(notesErrors.create('NOT_FOUND', {}))),
				result: k.string(),
			},
		},
	})
	const command = foundation.Command({
		contract,
		context: () => ({}),
		audit: () => null,
		operations: ({ command }) => ({
			save: command.handler(() => {
				throw argumentErrors.toConvexError('INVALID_ARGUMENTS', { issues: [] })
			}),
		}),
	})
	const query = foundation.Query({
		contract,
		context: () => ({}),
		operations: ({ query }) => ({
			read: query.handler(() => 'read'),
			neutral: query.handler(() => 'unreachable'),
			adaptedZod: query.handler(() => 'unreachable'),
			invalidResult: query.handler(() => 'short'),
			nested: query.handler(() => command.exec('save', invalidInput as never, undefined)),
			decoderFailure: query.handler(() => 'unreachable'),
		}),
	})
	const mutation = effectApiBuilder(nativeMutation, { errors: notesErrors })({
		args: { secret: v.union(v.number(), v.string()) },
		handler: (_ctx, args) => command.exec('save', args as never, undefined),
	})
	const read = effectApiBuilder(queryGeneric, { errors: notesErrors })({
		args: { secret: v.string() },
		handler: (_ctx, args) => query.exec('read', args as never, undefined),
	})
	const t = convexTest(schema, {
		...modules,
		'./fixture/argument-functions.ts': async () => ({ mutation, read }),
	})
	return { command, query, mutation, read, t, entries }
}

describe('Effect operation argument failures', () => {
	it('uses the shared auth policy for endpoint argument validation before the Effect handler', async () => {
		const handler = vi.fn(() => Effect.succeed('unreachable'))
		const auth = createEffectAuthFunctions(
			{
				query: queryGeneric,
				mutation: mutationGeneric,
				action: actionGeneric,
				internalQuery: internalQueryGeneric,
				internalMutation: internalMutationGeneric,
				internalAction: internalActionGeneric,
				getAuthUser: async () => null,
				mapRole: () => 'reader',
				adminRoles: ['reader'],
				argumentFailure: 'declared',
			},
			{
				query: {},
				mutation: {},
				action: {},
				systemQuery: { errors: notesErrors },
				systemMutation: {},
				systemAction: {},
			},
		)
		const read = auth.systemQuery({ args: { secret: k.string().min(100) }, handler })
		const t = convexTest(schema, {
			...modules,
			'./fixture/argument-functions.ts': async () => ({ read }),
		})
		const ref = makeFunctionReference<'query', typeof invalidInput>('argument-functions:read')
		const error = await t.query(ref, invalidInput).catch((error: unknown) => error)
		expect(failureOf(error, argumentContracts, 'INVALID_ARGUMENTS')?.details.issues).toEqual([
			expect.objectContaining({ path: ['secret'], code: 'too_small' }),
		])
		expect(handler).not.toHaveBeenCalled()
	})

	it('preserves each decoder failure in direct exec', async () => {
		const { command, query } = argumentHarness()
		await expect(
			Effect.runPromise(command.exec('save', invalidInput as never, undefined)),
		).rejects.toBeInstanceOf(KValidationError)
		await expect(
			Effect.runPromise(query.exec('read', invalidInput as never, undefined)),
		).rejects.toBeInstanceOf(Schema.SchemaError)
	})

	it('audits a nested custom primitive rejection once and preserves the value', async () => {
		const { query, entries } = argumentHarness(() => 'rejected')
		await expect(Effect.runPromise(query.exec('nested', {}, undefined))).rejects.toBe('rejected')
		expect(entries).toEqual([
			expect.objectContaining({ operation: 'save', errorCode: 'UNKNOWN_FAILURE', depth: 1 }),
		])
	})

	it.each([undefined, 'validation'] as const)(
		'throws the kit validation error for a k input past an error projection (%s)',
		async (policy) => {
			const { mutation, read, t } = argumentHarness(policy)
			const saveError = await t
				.mutation((ctx) => invoke(mutation, ctx, invalidInput))
				.catch((error: unknown) => error)
			expect(saveError).toBeInstanceOf(ConvexError)
			expect((saveError as ConvexError<Value>).data).toEqual({
				code: 'VALIDATION',
				issues: [expect.objectContaining({ path: ['secret'], code: 'invalid_type' })],
			})
			expect(JSON.stringify((saveError as ConvexError<Value>).data)).not.toContain(
				invalidInput.secret,
			)
			// An Effect Schema input keeps its typed failure, which the projection reports as unknown.
			const readError = await t
				.query((ctx) => invoke(read, ctx, invalidInput))
				.catch((error: unknown) => error)
			expect((readError as ConvexError<Value>).data).toEqual({ _tag: 'UnknownFailure', version: 1 })
		},
	)

	it('projects contract input rejections at both Convex boundaries and audits them without input', async () => {
		const { t, entries } = argumentHarness('declared')
		const saveError = await t
			.mutation(
				makeFunctionReference<'mutation', typeof invalidInput>('argument-functions:mutation'),
				invalidInput,
			)
			.catch((error: unknown) => error)
		const readError = await t
			.query(
				makeFunctionReference<'query', typeof invalidInput>('argument-functions:read'),
				invalidInput,
			)
			.catch((error: unknown) => error)
		expect(failureOf(saveError, argumentContracts, 'INVALID_ARGUMENTS')?.details.issues).toEqual([
			expect.objectContaining({ path: ['secret'], code: 'invalid_type' }),
		])
		expect(failureOf(readError, argumentContracts, 'INVALID_ARGUMENTS')?.details.issues).toEqual([
			expect.objectContaining({ path: ['secret'], code: 'InvalidType' }),
		])
		expect(JSON.stringify((readError as ConvexError<Value>).data)).not.toContain(
			invalidInput.secret,
		)
		expect(entries).toEqual([
			{
				kind: 'command',
				operation: 'save',
				classification: 'business',
				errorCode: 'INVALID_ARGUMENTS',
				declared: true,
				root: 'save',
				depth: 0,
			},
			{
				kind: 'query',
				operation: 'read',
				classification: 'query',
				errorCode: 'INVALID_ARGUMENTS',
				declared: true,
				root: 'read',
				depth: 0,
			},
		])
	})

	it('normalizes Standard Schema paths and applies the shared issue limits', async () => {
		const { query } = argumentHarness('declared')
		const exit = await Effect.runPromiseExit(query.exec('neutral', 'invalid', undefined))
		if (Exit.isSuccess(exit)) throw Error('expected failure')
		const rejection = failureOf(Cause.squash(exit.cause), argumentContracts, 'INVALID_ARGUMENTS')
		expect(rejection?.details.issues).toEqual(
			Array.from({ length: ARGUMENT_ISSUE_LIMITS.issues }, () => ({
				path: ['nested', 0],
				code: 'custom',
				message: 'Invalid input',
			})),
		)
		const zodError = await Effect.runPromise(query.exec('adaptedZod', 'x', undefined)).catch(
			(error: unknown) => error,
		)
		expect(failureOf(zodError, argumentContracts, 'INVALID_ARGUMENTS')?.details.issues).toEqual([
			expect.objectContaining({ path: [], code: 'too_small' }),
		])
	})

	it('retains the ConvexError in direct exec and audits a nested failure once', async () => {
		const { query, entries } = argumentHarness('declared')
		const exit = await Effect.runPromiseExit(query.exec('nested', {}, undefined))
		if (Exit.isSuccess(exit)) throw Error('expected failure')
		expect(decodeFailure(Cause.squash(exit.cause), argumentContracts)).toMatchObject({
			_tag: 'DeclaredFailure',
			code: 'INVALID_ARGUMENTS',
		})
		expect(entries).toEqual([
			expect.objectContaining({
				operation: 'save',
				errorCode: 'INVALID_ARGUMENTS',
				root: 'nested',
				depth: 1,
			}),
		])
	})

	it('throws the custom policy value through an endpoint with a declared error projector', async () => {
		const thrown = notesErrors.toConvexError('NOT_FOUND', {})
		const hook = vi.fn(() => thrown)
		const { mutation, t, entries } = argumentHarness(hook)
		await expect(t.mutation((ctx) => invoke(mutation, ctx, invalidInput))).rejects.toBe(thrown)
		expect(hook).toHaveBeenCalledExactlyOnceWith({
			source: 'arguments',
			issues: [expect.objectContaining({ path: ['secret'], code: 'invalid_type' })],
		})
		expect(entries).toEqual([
			expect.objectContaining({ errorCode: 'UNKNOWN_FAILURE', declared: false }),
		])
	})

	it('keeps handler defects and arbitrary typed decoder errors on their existing paths', async () => {
		const { mutation, query, t } = argumentHarness('declared')
		const error = await t
			.mutation((ctx) => invoke(mutation, ctx, { secret: 1 }))
			.catch((error: unknown) => error)
		expect((error as ConvexError<Value>).data).toEqual({ _tag: 'UnknownFailure', version: 1 })
		const exit = await Effect.runPromiseExit(query.exec('decoderFailure', undefined, undefined))
		if (Exit.isSuccess(exit)) throw Error('expected failure')
		expect(projectErrorCause(notesErrors, exit.cause)).toMatchObject({ code: 'NOT_FOUND' })
		await expect(
			Effect.runPromise(query.exec('invalidResult', {}, undefined)),
		).rejects.toBeInstanceOf(KValidationError)
	})
})
