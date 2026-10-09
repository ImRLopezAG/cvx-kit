import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { bindEffectCommand } from '../src/modules/effect/command'
import { Observability } from '../src/components/foundation/modules/observability/observability'

it('binds arbitrary context lazily and keeps concurrent handles independent', async () => {
	let resolved = 0
	const audits: number[] = []
	const permissions: number[] = []
	const Command = bindEffectCommand({
		observability: new Observability({
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
		}),
		writeAudit: (context: number) => {
			audits.push(context)
		},
		checkPermission: (context: number) => {
			permissions.push(context)
		},
	})
	const commands = Command({
		context: (value: number) => {
			resolved++
			return { value }
		},
		operations: ({ command }) => ({
			add: command({
				input: z.number(),
				result: z.number(),
				classification: 'business',
				permission: 'add',
				audit: (_resolution, ctx) => ({
					operation: 'add',
					actorId: String(ctx.value),
					aggregate: { type: 'number', id: String(ctx.value) },
				}),
				handler: (input, ctx) => input + ctx.value,
			}),
		}),
	})
	const first = commands.withContext(10)
	const second = commands.withContext(20)
	const effects = [first.exec('add', 1), second.exec('add', 2)]
	expect(resolved).toBe(0)
	expect(await Promise.all(effects.map((effect) => Effect.runPromise(effect)))).toEqual([11, 22])
	expect(resolved).toBe(2)
	expect(await Effect.runPromise(commands.exec('add', 3, 30))).toBe(33)
	expect(audits.sort()).toEqual([10, 20, 30])
	expect(permissions.sort()).toEqual([10, 20, 30])
})

it('composes independently bound nested commands without running an inner Effect early', async () => {
	const Command = bindEffectCommand({
		observability: new Observability({
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILURE' }),
		}),
		writeAudit: () => undefined,
	})
	let calls = 0
	const inner = Command({
		context: (label: string) => ({ label }),
		operations: ({ command }) => ({
			label: command({
				input: z.number(),
				result: z.string(),
				classification: 'business',
				audit: () => null,
				handler: (input, ctx) => {
					calls++
					return `${ctx.label}:${input}`
				},
			}),
		}),
	})
	const outer = Command({
		context: (context: { nested: ReturnType<typeof inner.withContext>; offset: number }) => context,
		operations: ({ command }) => ({
			run: command({
				input: z.number(),
				result: z.string(),
				classification: 'business',
				audit: () => null,
				handler: (input, ctx) => ctx.nested.exec('label', input + ctx.offset),
			}),
		}),
	})
	const effect = outer
		.withContext({ nested: inner.withContext('feature'), offset: 5 })
		.exec('run', 2)
	expect(calls).toBe(0)
	expect(await Effect.runPromise(effect)).toBe('feature:7')
	expect(calls).toBe(1)
})
