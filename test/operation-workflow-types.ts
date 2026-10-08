import { makeFunctionReference } from 'convex/server'
import type { WorkflowCtx } from '@convex-dev/workflow'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import { zodContract } from '../src/contracts'
import {
	workflowBinding,
	runWorkflowStep,
	type WorkflowExecution,
	type WorkflowHostState,
	type WorkflowOutcome,
	WorkflowBindingError,
	terminalWorkflowAttempt,
	workflowReceiptInvocation,
} from '../src/modules/contracts/workflow'
import {
	effectWorkflowAttempt,
	effectReceiptWorkflowMutation,
	effectTerminalWorkflowAttempt,
	effectWorkflowStatusBindings,
} from '../src/modules/effect/workflow'
import { ContractValidationError, effectContract } from '../src/modules/effect/schema'
import { effectTransactionalIdempotency } from '../src/modules/effect/idempotency'
import type { EffectValue } from '../src/modules/effect/operation'
import { IdempotencyError } from '../src/modules/contracts/idempotency'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type ErrorOf<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never
type ServicesOf<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never
const args = zodContract(z.object({ value: z.number() }))
const result = zodContract(z.number())
const metadata = {
	operation: 'save',
	operationVersion: '1',
	contractVersion: '1',
	bindingVersion: '1',
}
type Execution = WorkflowExecution<{ value: number }>
const reference = makeFunctionReference<'mutation', { execution: Execution }, number>('steps:save')
const binding = workflowBinding({ ...metadata, kind: 'mutation', args, result, reference })
declare const step: WorkflowCtx
declare const execution: Execution
runWorkflowStep(step, binding, execution)
workflowBinding({
	...metadata,
	kind: 'action',
	args,
	result,
	// @ts-expect-error mutation reference cannot become an action
	reference,
})
workflowBinding({
	...metadata,
	kind: 'mutation',
	args,
	result,
	// @ts-expect-error wrong generated argument type
	reference: makeFunctionReference<
		'mutation',
		{ execution: WorkflowExecution<{ value: string }> },
		number
	>('steps:wrongArgs'),
})
workflowBinding({
	...metadata,
	kind: 'mutation',
	args,
	result,
	// @ts-expect-error wrong generated result type
	reference: makeFunctionReference<'mutation', { execution: Execution }, string>(
		'steps:wrongResult',
	),
})
// @ts-expect-error action terminal wrapping must carry protected inner mutation evidence
terminalWorkflowAttempt({
	kind: 'action',
	authorize: () => 1,
	invokeMutation: async () => 2,
	terminal: () => undefined,
	result,
	failure: result,
})
// @ts-expect-error preferred mutation path requires host native proof assertion
terminalWorkflowAttempt({
	kind: 'mutation',
	authorize: () => 1,
	invokeMutation: async () => 2,
	terminal: () => undefined,
	result,
	failure: result,
})
class Authority extends Context.Service<Authority, string>()('WorkflowAuthority') {}
class Execute extends Context.Service<Execute, number>()('WorkflowExecute') {}
class AuthorizeFailure {
	readonly _tag = 'AuthorizeFailure'
}
class ExecuteFailure {
	readonly _tag = 'ExecuteFailure'
}
const attempt = effectWorkflowAttempt({
	authorize: (_execution: Execution) =>
		Authority.pipe(
			Effect.flatMap((value) =>
				value ? Effect.succeed(value) : Effect.fail(new AuthorizeFailure()),
			),
		),
	execute: (_execution, _authority) =>
		Execute.pipe(
			Effect.flatMap((value) =>
				value > 0 ? Effect.succeed(value) : Effect.fail(new ExecuteFailure()),
			),
		),
})
type Attempt = ReturnType<typeof attempt>
export type AttemptErrors = Assert<
	Equal<ErrorOf<Attempt>, WorkflowBindingError | AuthorizeFailure | ExecuteFailure>
>
export type AttemptServices = Assert<Equal<ServicesOf<Attempt>, Authority | Execute>>
class Replay extends Context.Service<Replay, number>()('WorkflowReplay') {}
class Encoder extends Context.Service<Encoder, number>()('WorkflowEncoder') {}
class Complete extends Context.Service<Complete, void>()('WorkflowComplete') {}
class CompleteFailure {
	readonly _tag = 'CompleteFailure'
}
class ReplayFailure {
	readonly _tag = 'ReplayFailure'
}
const replay = effectContract<number, number, ReplayFailure, Replay>(() =>
	Replay.pipe(
		Effect.flatMap((n) => (n >= 0 ? Effect.succeed(n) : Effect.fail(new ReplayFailure()))),
	),
)
const adapter = effectTransactionalIdempotency({
	final: { replayResult: replay, encode: (_result: number) => Encoder },
	authorize: () => undefined,
	lookup: () => [],
	fingerprint: (s) => s,
	claim: () => 'claim',
	complete: () => Complete.pipe(Effect.flatMap(() => Effect.fail(new CompleteFailure()))),
})
const protectedMutation = effectReceiptWorkflowMutation({
	authorize: (_execution: Execution) => Authority,
	receipt: () => adapter,
	invocation: (execution) =>
		workflowReceiptInvocation(execution, {
			scope: 'trusted',
			fingerprintPolicy: 'raw',
			bounds: {
				maxDepth: 10,
				maxNodes: 100,
				maxBytes: 1000,
				maxArrayLength: 10,
				maxObjectFields: 10,
			},
		}),
	execute: () => Execute,
})
type Protected = ReturnType<typeof protectedMutation.handler>
export type ProtectedServices = Assert<
	Equal<ServicesOf<Protected>, Authority | Execute | Replay | Encoder | Complete>
>
export type ProtectedHasReplayFailure = Assert<
	ReplayFailure extends ErrorOf<Protected> ? true : false
>
export type ProtectedHasCompletionFailure = Assert<
	CompleteFailure extends ErrorOf<Protected> ? true : false
>
export type ProtectedErrors = Assert<
	Equal<
		ErrorOf<Protected>,
		WorkflowBindingError | IdempotencyError | ReplayFailure | CompleteFailure
	>
>
const terminal = effectTerminalWorkflowAttempt({
	kind: 'action',
	protectedMutation,
	authorize: (_execution: Execution) => Authority,
	invokeMutation: async () => 2,
	terminal: () => undefined,
	result,
	failure: result,
})
export type TerminalServices = Assert<Equal<ServicesOf<ReturnType<typeof terminal>>, Authority>>
class StatusReader extends Context.Service<StatusReader, WorkflowHostState<number>>()(
	'StatusReader',
) {}
class StatusWriter extends Context.Service<StatusWriter, void>()('StatusWriter') {}
class StatusNative extends Context.Service<StatusNative, 'failed'>()('StatusNative') {}
class StatusReceipt extends Context.Service<StatusReceipt, WorkflowOutcome<number>>()(
	'StatusReceipt',
) {}
class StatusCancel extends Context.Service<StatusCancel, void>()('StatusCancel') {}
class StatusRestart extends Context.Service<StatusRestart, void>()('StatusRestart') {}
const statuses = effectWorkflowStatusBindings({
	authorize: () => Authority,
	read: () => StatusReader,
	write: () => StatusWriter,
	nativeStatus: () => StatusNative,
	receiptOutcome: () => StatusReceipt,
	cancelNative: () => StatusCancel,
	restartNative: () => StatusRestart,
})
export type CallbackServices = Assert<
	Equal<ServicesOf<ReturnType<typeof statuses.callback>>, Authority | StatusReader | StatusWriter>
>
export type ReconcileServices = Assert<
	Equal<
		ServicesOf<ReturnType<typeof statuses.reconcile>>,
		Authority | StatusReader | StatusWriter | StatusNative | StatusReceipt
	>
>
export type CancelServices = Assert<
	Equal<
		ServicesOf<ReturnType<typeof statuses.cancel>>,
		Authority | StatusReader | StatusWriter | StatusCancel
	>
>
export type RestartServices = Assert<
	Equal<
		ServicesOf<ReturnType<typeof statuses.restart>>,
		Authority | StatusReader | StatusWriter | StatusRestart
	>
>
const transformedResult = zodContract(z.number().transform(String))
const transformedBinding = workflowBinding({
	...metadata,
	kind: 'mutation',
	args,
	result: transformedResult,
	reference,
})
const wireResult = runWorkflowStep(step, transformedBinding, execution)
export type NativeWireResult = Assert<Equal<Awaited<typeof wireResult>, number>>

const safeTerminalFailure = zodContract(
	z.object({ providerCode: z.number() }).transform(() => ({ code: 'declined' as const })),
)
const neutralSafeTerminal = terminalWorkflowAttempt({
	kind: 'mutation',
	atomicJournalProof: 'host-verified',
	authorize: (_execution: Execution) => 'trusted',
	invokeMutation: async () => 2,
	terminal: () => ({ providerCode: 402 }),
	result: transformedResult,
	failure: safeTerminalFailure,
})
export type NeutralSafeTerminalOutput = Assert<
	Equal<
		Awaited<ReturnType<typeof neutralSafeTerminal>>,
		WorkflowOutcome<number, { code: 'declined' }>
	>
>
const effectSafeTerminal = effectTerminalWorkflowAttempt({
	kind: 'mutation',
	atomicJournalProof: 'host-verified',
	authorize: (_execution: Execution) =>
		Authority.pipe(
			Effect.flatMap((value) =>
				value ? Effect.succeed(value) : Effect.fail(new AuthorizeFailure()),
			),
		),
	invokeMutation: async () => 2,
	terminal: () =>
		Execute.pipe(
			Effect.flatMap((value) =>
				value > 0 ? Effect.succeed({ providerCode: value }) : Effect.fail(new ExecuteFailure()),
			),
		),
	result: transformedResult,
	failure: effectContract<{ providerCode: number }, { code: 'declined' }, ReplayFailure, Replay>(
		() =>
			Replay.pipe(
				Effect.flatMap((value) =>
					value > 0
						? Effect.succeed({ code: 'declined' as const })
						: Effect.fail(new ReplayFailure()),
				),
			),
	),
})
type EffectSafeTerminal = ReturnType<typeof effectSafeTerminal>
export type EffectSafeTerminalOutput = Assert<
	Equal<EffectValue<EffectSafeTerminal>, WorkflowOutcome<number, { code: 'declined' }>>
>
export type EffectSafeTerminalErrors = Assert<
	Equal<
		ErrorOf<EffectSafeTerminal>,
		| WorkflowBindingError
		| AuthorizeFailure
		| ExecuteFailure
		| ReplayFailure
		| ContractValidationError
	>
>
export type EffectSafeTerminalServices = Assert<
	Equal<ServicesOf<EffectSafeTerminal>, Authority | Execute | Replay>
>
