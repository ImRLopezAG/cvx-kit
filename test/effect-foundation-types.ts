import { Context, Effect } from 'effect'
import { z } from 'zod'
import { createEffectFoundation } from '../src/effect'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
class AuditStore extends Context.Service<AuditStore, { append: () => void }>()('AuditStore') {}
class PermissionFailure {
	readonly _tag = 'PermissionFailure'
}
class DomainFailure {
	readonly _tag = 'DomainFailure'
}
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed' as const, errorCode: 'FAILED' }),
	},
	checkPermission: (_host: { actorId: string }) => Effect.fail(new PermissionFailure()),
	writeAudit: (_host: { actorId: string }) =>
		Effect.gen(function* () {
			;(yield* AuditStore).append()
		}),
})
const queries = foundation.Query({
	context: (host: { actorId: string }) => host,
	operations: ({ query }) => ({
		read: query({
			input: z.string(),
			result: z.number(),
			permission: 'read',
			handler: (input) => input.length,
		}),
	}),
})
const commands = foundation.Command({
	context: (host: { actorId: string }) => host,
	operations: ({ command }) => ({
		rename: command({
			input: z.string(),
			result: z.number(),
			classification: 'business',
			permission: 'write',
			handler: (_input, host) =>
				queries.exec('read', 'read', host).pipe(Effect.andThen(Effect.fail(new DomainFailure()))),
			audit: () => null,
		}),
	}),
})
const execution = commands.exec('rename', 'input', { actorId: 'actor' })
type Success = Assert<Equal<Effect.Success<typeof execution>, number>>
type ErrorChannel = Assert<Equal<Effect.Error<typeof execution>, PermissionFailure | DomainFailure>>
type Requirements = Assert<Equal<Effect.Services<typeof execution>, AuditStore>>
const assertions: [Success, ErrorChannel, Requirements] = [true, true, true]
void assertions
// @ts-expect-error the shared audit policy still requires its service
Effect.runPromise(execution)
// @ts-expect-error raw operation input remains a string
commands.exec('rename', 1, { actorId: 'actor' })
foundation.Query({
	// @ts-expect-error the shared permission policy requires trusted actor context
	context: (host: { title: string }) => host,
	operations: ({ query }) => ({
		read: query({ input: z.string(), result: z.string(), handler: (input) => input }),
	}),
})
