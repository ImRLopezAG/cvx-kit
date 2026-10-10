import { convexTest } from 'convex-test'
import {
	defineSchema,
	defineTable,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericMutationCtx,
} from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { Cause, Effect, Exit } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { convexContract, defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { createEffectFoundation, projectErrorCause, effectApiBuilder } from '../src/effect'
import { defineErrorContract } from '../src/errors'
const schema = defineSchema({ writes: defineTable({ kind: v.string() }) })
type Host = GenericMutationCtx<DataModelFromSchemaDefinition<typeof schema>>
const modules = import.meta.glob('./fixture/**/*.ts')
const observability = {
	enabled: false,
	classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
}
for (const effect of [false, true]) {
	for (const failure of ['audit', 'write', 'complete'] as const) {
		it(`${effect ? 'Effect' : 'Promise'} rolls back native writes when root ${failure} fails`, async () => {
			const domain = defineDomainContract({
				commands: { save: { input: z.string(), result: z.string(), classification: 'business' } },
			})
			const writeAudit = async (host: Host) => {
				await host.db.insert('writes', { kind: 'audit' })
				if (failure === 'write') throw Error(failure)
			}
			const audit = () => {
				if (failure === 'audit') throw Error(failure)
				return { operation: 'save', actorId: 'actor', aggregate: { type: 'task', id: '1' } }
			}
			const normal = createFoundation({ observability, writeAudit }).Command({
				contract: domain,
				context: (host: Host) => host,
				audit,
				operations: ({ command }) => ({
					save: command.save({
						handler: async (input, context) => {
							await context.db.insert('writes', { kind: 'handler' })
							return input
						},
						prepare: (context) => ({
							kind: 'execute',
							complete: async () => {
								await context.db.insert('writes', { kind: 'complete' })
								if (failure === 'complete') throw Error(failure)
							},
						}),
					}),
				}),
			})
			const optional = createEffectFoundation({ observability, writeAudit }).Command({
				contract: domain,
				context: (host: Host) => host,
				audit,
				operations: ({ command }) => ({
					save: command.save({
						handler: async (input, context) => {
							await context.db.insert('writes', { kind: 'handler' })
							return input
						},
						prepare: (context) => ({
							kind: 'execute',
							complete: async () => {
								await context.db.insert('writes', { kind: 'complete' })
								if (failure === 'complete') throw Error(failure)
							},
						}),
					}),
				}),
			})
			const t = convexTest(schema, modules)
			await expect(
				t.mutation((host) =>
					effect
						? Effect.runPromise(optional.exec('save', '1', host))
						: normal.exec('save', '1', host),
				),
			).rejects.toThrow(failure)
			expect(await t.run((host) => host.db.query('writes').collect())).toEqual([])
		})
	}
	it(`${effect ? 'Effect' : 'Promise'} preserves native validator identity when exposing contracts`, () => {
		const native = v.object({ id: v.string() })
		const domain = defineDomainContract({
			commands: {
				save: { input: convexContract(native), result: z.string(), classification: 'business' },
			},
		})
		const options = { observability, writeAudit: () => undefined }
		const normal = createFoundation(options).Command({
			contract: domain,
			context: () => ({}),
			audit: () => null,
			operations: ({ command }) => ({ save: command.save({ handler: (input) => input.id }) }),
		})
		const optional = createEffectFoundation(options).Command({
			contract: domain,
			context: () => ({}),
			audit: () => null,
			operations: ({ command }) => ({ save: command.save({ handler: (input) => input.id }) }),
		})
		const selection = (effect ? optional : normal).expose(Symbol('tasks'), 'save')
		expect(selection.input).toBe(domain.commands.save.input)
		expect(selection.input.nativeValidator).toBe(native)
	})
}
it('passes the original root error projector through the Effect boundary', async () => {
	const errors = defineErrorContract({ Missing: { message: 'Missing task', details: {} } })
	const domain = defineDomainContract({
		errors,
		queries: { get: { input: z.string(), result: z.string() } },
	})
	const { Query } = createEffectFoundation({ observability, writeAudit: () => undefined })
	const queries = Query({
		contract: domain,
		context: () => ({}),
		operations: ({ query }) => ({
			get: query.get({ handler: () => Effect.fail(domain.errors.create('Missing', {})) }),
		}),
	})
	const exit = await Effect.runPromiseExit(queries.exec('get', '1', {}))
	if (Exit.isSuccess(exit)) throw Error('expected declared failure')
	expect(projectErrorCause(domain.errors, exit.cause)).toEqual(
		errors.project(errors.create('Missing', {})),
	)
	const foreign = defineErrorContract({ Missing: { message: 'Missing task', details: {} } })
	expect(projectErrorCause(domain.errors, Cause.fail(foreign.create('Missing', {})))).toEqual({
		_tag: 'UnknownFailure',
		version: 1,
	})
	expect(projectErrorCause(domain.errors, Cause.fail({ code: 'Missing' }))).toEqual({
		_tag: 'UnknownFailure',
		version: 1,
	})
})

it('projects contracted failures through the actual native Effect API', async () => {
	const errors = defineErrorContract({ Missing: { message: 'Missing task', details: {} } })
	const foreign = defineErrorContract({ Missing: { message: 'Missing task', details: {} } })
	const domain = defineDomainContract({
		errors,
		queries: { get: { input: z.string(), result: z.string() } },
	})
	for (const failure of ['declared', 'foreign', 'defect'] as const) {
		const queries = createEffectFoundation({ observability, writeAudit: () => undefined }).Query({
			contract: domain,
			context: () => ({}),
			operations: ({ query }) => ({
				get: query.get({
					handler: () =>
						failure === 'defect'
							? Effect.die(Error('private'))
							: Effect.fail(
									(failure === 'declared' ? domain.errors : foreign).create('Missing', {}),
								),
				}),
			}),
		})
		const api = effectApiBuilder(queryGeneric, { errors: domain.errors })
		const registered = api({
			args: { id: v.string() },
			returns: v.string(),
			handler: (host, args) => queries.exec('get', args.id, host),
		})
		// SAFETY: Convex builders retain _handler at runtime; registration declarations intentionally omit it.
		const invoke = registered as typeof registered & {
			_handler: (host: Host, args: { id: string }) => Promise<string>
		}
		try {
			await convexTest(schema, modules).run((host) => invoke._handler(host, { id: '1' }))
			throw Error('expected failure')
		} catch (error) {
			expect(error).toBeInstanceOf(ConvexError)
			if (!(error instanceof ConvexError)) throw error
			expect(error.data).toEqual(
				failure === 'declared'
					? errors.project(errors.create('Missing', {}))
					: { _tag: 'UnknownFailure', version: 1 },
			)
		}
	}
})
