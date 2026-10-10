import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
import { createFoundation } from '../src/index'
import { createEffectFoundation } from '../src/effect'

it.each(['promise', 'effect'] as const)(
	'binds handler-first %s registries and preserves audit and validation',
	async (mode) => {
		const events: string[] = []
		const contract = defineDomainContract({
			commands: {
				'notifications.markRead': {
					input: z.string().transform(Number).pipe(z.number()),
					result: z.number().transform((n) => ({ n })),
					classification: 'business',
				},
				close: {
					input: z.object({ id: z.string() }),
					result: z.boolean(),
					classification: 'business',
				},
			},
			queries: {
				get: { input: z.number(), result: z.string() },
				handler: { input: z.boolean(), result: z.boolean() },
			},
		})
		const options = {
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
			},
			writeAudit: () => undefined,
		}
		const adapter: object =
			mode === 'effect' ? createEffectFoundation(options) : createFoundation(options)
		// SAFETY: both adapters accept these declarations; the type fixture verifies their distinct execution types.
		const foundation = adapter as ReturnType<typeof createFoundation<typeof options>>
		const context = (host: { actor: string }) => host
		const commands = foundation.Command({
			contract,
			context,
			audit: ({ operation, input, result }) => {
				events.push(`${operation}:${input}:${JSON.stringify(result)}`)
				return null
			},
			operations: ({ command }) => ({
				'notifications.markRead': command.handler(
					async (input, ctx) => {
						events.push(ctx.actor)
						return input + 1
					},
					{
						guard: (_ctx, input) => {
							events.push(`guard:${input}`)
						},
					},
				),
				close: command.handler((input) => input.id.length > 0, {
					audit: ({ result }) => {
						events.push(`override:${result}`)
						return null
					},
				}),
			}),
		})
		let captured: object | undefined
		const queries = foundation.Query({
			contract,
			context,
			operations: ({ query }) => ({
				get: (captured = query.handler<
					typeof contract.queries.get.input,
					typeof contract.queries.get.result,
					'get',
					string
				>((input) => String(input))),
				// The existing named helper still works when its operation is called "handler".
				handler: query.handler({ handler: (input) => !input }),
			}),
		})
		async function run(value: Promise<unknown> | Effect.Effect<unknown, unknown, never>) {
			return Effect.isEffect(value) ? Effect.runPromise(value) : await value
		}
		expect(events).toEqual([])
		expect(await run(commands.exec('notifications.markRead', '2', { actor: 'a' }))).toEqual({
			n: 3,
		})
		expect(events).toEqual(['guard:2', 'a', 'notifications.markRead:2:{"n":3}'])
		expect(await run(commands.exec('close', { id: 'n' }, { actor: 'a' }))).toBe(true)
		expect(events.at(-1)).toBe('override:true')
		expect(await run(queries.exec('get', 3, { actor: 'a' }))).toBe('3')
		expect(await run(queries.exec('handler', false, { actor: 'a' }))).toBe(true)
		Object.assign(captured!, { handler: () => 'mutated' })
		expect(await run(queries.exec('get', 3, { actor: 'a' }))).toBe('3')
		const foreign = defineDomainContract({ queries: { ...contract.queries } })
		// SAFETY: malformed JavaScript reuses a draft from another declaration set.
		expect(() =>
			foundation.Query({
				contract: foreign,
				context,
				operations: () => ({ get: captured, handler: captured }),
			} as never),
		).toThrow('own contract helper')
		const before = [...events]
		await expect(
			run(commands.exec('notifications.markRead', 'bad', { actor: 'a' })),
		).rejects.toThrow()
		expect(events).toEqual(before)
		// SAFETY: intentionally malformed JavaScript map exercises runtime exact-key enforcement.
		expect(() => foundation.Query({ contract, context, operations: () => ({}) } as never)).toThrow(
			'keys must match exactly',
		)
		// SAFETY: a direct object has no helper provenance, even when its callbacks look valid.
		expect(() =>
			foundation.Query({
				contract,
				context,
				operations: () => ({ get: { handler: () => '3' }, handler: { handler: () => true } }),
			} as never),
		).toThrow('own contract helper')
		// SAFETY: intentionally malformed options exercise runtime protected-field enforcement.
		expect(() =>
			foundation.Query({
				contract,
				context,
				operations: ({ query }) => ({
					get: query.handler(() => '3', { input: z.string() } as never),
					handler: query.handler((input) => input),
				}),
			}),
		).toThrow('cannot override input')
	},
)
