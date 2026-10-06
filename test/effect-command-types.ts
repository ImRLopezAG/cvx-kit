import { Context, Effect } from 'effect'
import { z } from 'zod'
import { bindEffectCommand } from '../src/components/foundation/modules/effect/command'
import { Observability } from '../src/components/foundation/modules/observability/observability'

type Equal<Left, Right> =
	(<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false
type Assert<Value extends true> = Value
type ErrorOf<Value> =
	Value extends Effect.Effect<infer _Success, infer Error, infer _Requirements> ? Error : never
type ServicesOf<Value> =
	Value extends Effect.Effect<infer _Success, infer _Error, infer Requirements>
		? Requirements
		: never
class Repository extends Context.Service<Repository, number>()('TypedRepository') {}
class Policy extends Context.Service<Policy, number>()('TypedPolicy') {}
class Writer extends Context.Service<Writer, number>()('TypedWriter') {}
class ResolverFailure {
	readonly _tag = 'ResolverFailure'
}
class HandlerFailure {
	readonly _tag = 'HandlerFailure'
}
class CompleteFailure {
	readonly _tag = 'CompleteFailure'
}
class PolicyFailure {
	readonly _tag = 'PolicyFailure'
}
class WriterFailure {
	readonly _tag = 'WriterFailure'
}
type Host = { actorId: string }
const create = bindEffectCommand({
	observability: new Observability({
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'ERROR' }),
	}),
	checkPermission: (_host: Host) =>
		Effect.gen(function* () {
			yield* Policy
			return yield* Effect.fail(new PolicyFailure())
		}),
	writeAudit: (_host: Host) =>
		Effect.gen(function* () {
			yield* Writer
			return yield* Effect.fail(new WriterFailure())
		}),
})
const commands = create({
	context: (host: Host) =>
		Effect.gen(function* () {
			if (!host.actorId) return yield* Effect.fail(new ResolverFailure())
			return host
		}),
	operations: ({ command }) => ({
		plain: command({
			input: z.string(),
			result: z.number().transform(String),
			classification: 'business',
			audit: () => null,
			handler: (input) => input.length,
		}),
		typed: command({
			input: z.number(),
			result: z.number(),
			classification: 'business',
			audit: () => null,
			prepare: () => ({
				kind: 'execute' as const,
				complete: () => Effect.fail(new CompleteFailure()),
			}),
			handler: (input) =>
				Effect.gen(function* () {
					yield* Repository
					if (input < 0) return yield* Effect.fail(new HandlerFailure())
					return input
				}),
		}),
	}),
})
const plain = commands.exec('plain', 'title', { actorId: 'actor' })
const typed = commands.exec('typed', 1, { actorId: 'actor' })
type PlainErrors = Assert<
	Equal<ErrorOf<typeof plain>, ResolverFailure | PolicyFailure | WriterFailure>
>
type TypedErrors = Assert<
	Equal<
		ErrorOf<typeof typed>,
		ResolverFailure | HandlerFailure | CompleteFailure | PolicyFailure | WriterFailure
	>
>
type PlainServices = Assert<Equal<ServicesOf<typeof plain>, Policy | Writer>>
type TypedServices = Assert<Equal<ServicesOf<typeof typed>, Repository | Policy | Writer>>
const assertions: [PlainErrors, TypedErrors, PlainServices, TypedServices] = [
	true,
	true,
	true,
	true,
]
void assertions
// @ts-expect-error raw input is operation-specific
commands.exec('plain', 4, { actorId: 'actor' })
// @ts-expect-error host context is trusted policy input, not caller data
commands.exec('plain', 'title', 'actor')
// @ts-expect-error missing per-operation and foundation services cannot reach the runner
void Effect.runPromise(typed)
create({
	// @ts-expect-error resolver host must match shared permission/audit policies
	context: (host: string) => host,
	operations: ({ command }) => ({
		invalid: command({
			input: z.number(),
			result: z.number(),
			classification: 'business',
			audit: () => null,
			handler: (input) => input,
		}),
	}),
})
