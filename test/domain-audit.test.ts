/* oxlint-disable anti-slop/no-object-parameters, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Interpreter parity fixture deliberately erases the two execution kinds; separate fixtures verify their precise public types. */
import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { createEffectFoundation } from '../src/effect'
import { snapshotOperations, bindDomainImplementation } from '../src/modules/contracts/binding'

for (const effect of [false, true]) {
	it(`${effect ? 'Effect' : 'Promise'} selects one audit and skips it on replay`, async () => {
		const events: string[] = []
		let replay = false
		const domain = defineDomainContract({
			commands: {
				save: {
					input: z.string(),
					result: z.string().transform((value) => ({ value })),
					replayResult: z.object({ value: z.string() }),
					classification: 'business',
				},
				close: { input: z.number(), result: z.number(), classification: 'business' },
			},
		})
		const options = {
			observability: {
				enabled: false,
				// SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
				classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
			},
			checkPermission: (_host: { actor: string }) => {
				events.push('permission')
			},
			writeAudit: (_host: { actor: string }) => {
				events.push('write')
			},
		}
		const configuration = {
			contract: domain,
			context: (host: { actor: string }) => host,
			audit: (
				resolution:
					| { operation: 'save'; input: string; result: { value: string } }
					| { operation: 'close'; input: number; result: number },
				context: { actor: string },
			) => {
				events.push(`default:${resolution.operation}:${context.actor}`)
				return {
					operation: resolution.operation,
					actorId: context.actor,
					aggregate: { type: 'task', id: '1' },
				}
			},
			operations: ({
				command,
			}: {
				command: Record<string, (implementation: object) => object>
			}) => ({
				save: command.save({
					permission: 'write',
					prepare: () =>
						replay
							? { kind: 'replay', result: { value: 'cached' } }
							: {
									kind: 'execute',
									complete: () => {
										events.push('complete')
									},
								},
					middleware: ({ next }: { next: (options: { context: object }) => unknown }) =>
						next({ context: { actor: 'enriched' } }),
					handler: (input: string, context: { actor: string }) => {
						events.push(`handler:${context.actor}`)
						return input
					},
				}),
				close: command.close({
					handler: (input: number) => input,
					audit: () => {
						events.push('override')
						return null
					},
				}),
			}),
		}
		// SAFETY: this test exercises the same heterogeneous runtime configuration on both interpreters; unannotated public typing is tested separately.
		const registry = effect
			? // SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
				createEffectFoundation(options).Command(configuration as never)
			: // SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
				createFoundation(options).Command(configuration as never)
		const execute = (key: string, input: unknown) =>
			effect
				? Effect.runPromise(
						// SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
						(
							registry.exec as (
								key: string,
								input: unknown,
								host: { actor: string },
							) => Effect.Effect<unknown>
						)(key, input, { actor: 'base' }),
					)
				: // SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
					(
						registry.exec as (
							key: string,
							input: unknown,
							host: { actor: string },
						) => Promise<unknown>
					)(key, input, { actor: 'base' })
		expect(events).toEqual([])
		expect(await execute('save', 'fresh')).toEqual({ value: 'fresh' })
		expect(events).toEqual([
			'permission',
			'handler:enriched',
			'default:save:base',
			'write',
			'complete',
		])
		events.length = 0
		expect(await execute('close', 1)).toBe(1)
		expect(events).toEqual(['override'])
		events.length = 0
		replay = true
		expect(await execute('save', 'ignored')).toEqual({ value: 'cached' })
		expect(events).toEqual(['permission'])
	})
}
it('rejects untyped overrides, missing keys, mismatched helpers, and mutated definitions', () => {
	const entry = { input: z.string(), result: z.string(), classification: 'business' }
	const contract = defineDomainContract({ commands: { a: entry, b: entry } })
	expect(() => bindDomainImplementation('a', entry, { input: z.number() })).toThrow(
		'cannot override input',
	)
	expect(() => snapshotOperations({ a: {} }, contract, 'commands', () => null)).toThrow(
		'match exactly',
	)
	const a = bindDomainImplementation('a', entry, { handler: () => '', audit: () => null })
	expect(() => snapshotOperations({ a, b: a }, contract, 'commands')).toThrow('own contract helper')
	Object.assign(a, { input: z.number() })
	expect(() =>
		snapshotOperations(
			{ a, b: bindDomainImplementation('b', entry, {}) },
			contract,
			'commands',
			() => null,
		),
	).toThrow('own contract helper')
})
it('snapshots operation records while preserving validators', () => {
	const wire = { schema: z.string(), project: (value: string) => value }
	const wireSchema = wire.schema
	const entry = { input: z.string(), result: z.string(), classification: 'business', wire }
	const original = { ...entry, handler: () => 'original', audit: () => null }
	const operations = { a: original }
	const snapshot = snapshotOperations(operations, undefined, 'commands')
	operations.a.handler = () => 'changed'
	wire.schema = z.string().min(10)
	wire.project = () => 'changed'
	// SAFETY: snapshot storage erases wire fields; this fixture owns the original schema-paired record.
	const savedWire = snapshot.a.wire as typeof wire
	expect(savedWire.schema).toBe(wireSchema)
	expect(savedWire.project('original')).toBe('original')
	expect(snapshot.a.input).toBe(entry.input)
	// SAFETY: this parity fixture executes the same schema-paired configuration; dedicated compile fixtures prove both public signatures.
	expect((snapshot.a.handler as () => string)()).toBe('original')
	expect(Object.isFrozen(snapshot)).toBe(true)
})
for (const present of [false, true]) {
	it(`selects the shared audit only when an optional override is absent (${present})`, async () => {
		const events: string[] = []
		const contract = defineDomainContract({
			commands: { save: { input: z.string(), result: z.string(), classification: 'business' } },
		})
		const override = present
			? () => {
					events.push('override')
					return null
				}
			: undefined
		const options = {
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
			},
			writeAudit: () => undefined,
		}
		const audit = () => {
			events.push('root')
			return null
		}
		const normal = createFoundation(options).Command({
			contract,
			context: () => ({}),
			audit,
			operations: ({ command }) => ({
				save: command.save({ handler: (input) => input, audit: override }),
			}),
		})
		const optional = createEffectFoundation(options).Command({
			contract,
			context: () => ({}),
			audit,
			operations: ({ command }) => ({
				save: command.save({ handler: (input) => input, audit: override }),
			}),
		})
		await normal.exec('save', '1', undefined)
		await Effect.runPromise(optional.exec('save', '1', undefined))
		expect(events).toEqual(present ? ['override', 'override'] : ['root', 'root'])
	})
}
