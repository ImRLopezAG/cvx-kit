import { Effect } from 'effect'
import { expect, it } from 'vite-plus/test'
import { k } from '../src/k'
import { createEffectFoundation } from '../src/effect'
import { createFoundation } from '../src/index'

const dependencies = {
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAIL' }),
	},
	writeAudit: () => undefined,
}

it('decodes every Effect void handler result to null in commands and queries', async () => {
	const foundation = createEffectFoundation(dependencies)
	const handlers = {
		void: () => Effect.void,
		undefined: () => Effect.succeed(undefined),
		generator: () =>
			Effect.gen(function* () {
				yield* Effect.void
			}),
		null: () => Effect.succeed(null),
	}
	for (const handler of Object.values(handlers)) {
		const commands = foundation.Command({
			context: (host: { actor: string }) => host,
			operations: ({ command }) => ({
				run: command({
					input: k.null(),
					result: k.void(),
					classification: 'business',
					audit: () => null,
					handler,
				}),
			}),
		})
		const queries = foundation.Query({
			context: (host: { actor: string }) => host,
			operations: ({ query }) => ({ run: query({ input: k.null(), result: k.void(), handler }) }),
		})
		const commandResult: null = await Effect.runPromise(commands.exec('run', null, { actor: 'a' }))
		const queryResult: null = await Effect.runPromise(queries.exec('run', null, { actor: 'a' }))
		expect(commandResult).toBeNull()
		expect(queryResult).toBeNull()
	}
})

it('decodes ordinary void handler results to null in commands and queries', async () => {
	const foundation = createFoundation(dependencies)
	const handlers = [() => undefined, () => {}, () => null]
	for (const handler of handlers) {
		const commands = foundation.Command({
			context: (host: { actor: string }) => host,
			operations: ({ command }) => ({
				run: command({
					input: k.null(),
					result: k.void(),
					classification: 'business',
					audit: () => null,
					handler,
				}),
			}),
		})
		const queries = foundation.Query({
			context: (host: { actor: string }) => host,
			operations: ({ query }) => ({ run: query({ input: k.null(), result: k.void(), handler }) }),
		})
		const commandResult: null = await commands.exec('run', null, { actor: 'a' })
		const queryResult: null = await queries.exec('run', null, { actor: 'a' })
		expect(commandResult).toBeNull()
		expect(queryResult).toBeNull()
	}
})
