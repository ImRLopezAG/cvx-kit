import { Effect } from 'effect'
import type { ContractInput, ContractOutput, ContractSchema } from '../contracts/contract'
import {
	WorkflowBindingError,
	workflowExecution,
	workflowTransition,
	workflowCancel,
	workflowRestart,
	type WorkflowExecution,
	type WorkflowOutcome,
	type WorkflowHostState,
	type WorkflowNativeStatus,
} from '../contracts/workflow'
import type { IdempotencyInvocation } from '../contracts/idempotency'
import type { EffectIdempotencyPreparation } from './idempotency'
import type { CallbackError, CallbackRequirements, EffectValue } from './operation'
import { normalizeEffect } from './normalize'
import {
	decodeEffectContract,
	type ContractDecoderError,
	type ContractDecoderRequirements,
} from './schema'

type Supported<A> = A | PromiseLike<A> | Effect.Effect<A, unknown, unknown>
/** Services exist only inside a new native invocation; ordinary throws/rejections remain defects. */
export function effectWorkflowAttempt<Args, Authorize, Execute>(configuration: {
	authorize: (execution: WorkflowExecution<Args>) => Authorize
	execute: (execution: WorkflowExecution<Args>, authority: EffectValue<Authorize>) => Execute
}) {
	return (
		input: WorkflowExecution<Args>,
	): Effect.Effect<
		EffectValue<Execute>,
		WorkflowBindingError | CallbackError<Authorize | Execute>,
		CallbackRequirements<Authorize | Execute>
	> =>
		Effect.gen(function* () {
			const execution = yield* descriptor(input)
			const authority = yield* normalizeEffect(() => configuration.authorize(execution))
			return yield* normalizeEffect(() => configuration.execute(execution, authority))
		})
}
/** Native mutation promise rejects outside the child transaction before mapping declared terminal details. */
export function effectTerminalWorkflowAttempt<
	Args,
	Authorize,
	const Result extends ContractSchema,
	const Failure extends ContractSchema,
	Terminal extends Supported<ContractInput<Failure> | undefined>,
>(
	configuration: (
		| { kind: 'mutation'; atomicJournalProof: 'host-verified' }
		| {
				kind: 'action'
				protectedMutation: EffectReceiptProtectedWorkflowMutation<Args, unknown, unknown, unknown>
		  }
	) & {
		authorize: (execution: WorkflowExecution<Args>) => Authorize
		invokeMutation: (
			execution: WorkflowExecution<Args>,
			authority: EffectValue<Authorize>,
		) => Promise<ContractInput<Result>>
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- A rejected native mutation can throw any value; the host terminal callback classifies it before failure contract validation.
		terminal: (error: unknown) => Terminal
		result: Result
		failure: Failure
	},
) {
	return (
		input: WorkflowExecution<Args>,
	): Effect.Effect<
		WorkflowOutcome<ContractInput<Result>, ContractOutput<Failure>>,
		| WorkflowBindingError
		| CallbackError<Authorize | Terminal>
		| ContractDecoderError<Result | Failure>,
		CallbackRequirements<Authorize | Terminal> | ContractDecoderRequirements<Result | Failure>
	> =>
		Effect.gen(function* () {
			const execution = yield* descriptor(input)
			const authority = yield* normalizeEffect(() => configuration.authorize(execution))
			const native = yield* Effect.tryPromise({
				try: () => configuration.invokeMutation(execution, authority),
				catch: (error) => error,
			}).pipe(
				Effect.map((value) => ({ kind: 'success' as const, value })),
				Effect.catch((error) => Effect.succeed({ kind: 'rejected' as const, error })),
			)
			if (native.kind === 'rejected') {
				const failure = yield* normalizeEffect(() => configuration.terminal(native.error))
				if (failure === undefined) return yield* Effect.die(native.error)
				// SAFETY: Terminal is constrained to this exact failure wire input or undefined.
				const error = yield* decodeEffectContract(
					configuration.failure,
					failure as ContractInput<Failure>,
				)
				yield* descriptor({ ...execution, args: error })
				return { version: 1 as const, kind: 'failed' as const, error }
			}
			yield* decodeEffectContract(configuration.result, native.value)
			yield* descriptor({ ...execution, args: native.value })
			return { version: 1 as const, kind: 'succeeded' as const, value: native.value }
		})
}
declare const protectedMutation: unique symbol
export interface EffectReceiptProtectedWorkflowMutation<Args, Result, Error, Requirements> {
	readonly [protectedMutation]: { args: Args; result: Result }
	readonly handler: (
		execution: WorkflowExecution<Args>,
	) => Effect.Effect<Result, Error, Requirements>
}
type Completion<Prepare> =
	Extract<EffectValue<Prepare>, { kind: 'execute' }> extends {
		complete: (...arguments_: never[]) => infer Returned
	}
		? Returned
		: never
/** Host runs the handler in the secured inner native mutation transaction, including receipt completion. */
export function effectReceiptWorkflowMutation<
	Args,
	Authorize,
	const Replay extends ContractSchema,
	Prepare extends Supported<EffectIdempotencyPreparation<ContractOutput<Replay>, unknown, unknown>>,
	Execute extends Supported<ContractOutput<Replay>>,
>(configuration: {
	authorize: (execution: WorkflowExecution<Args>) => Authorize
	receipt: (authority: EffectValue<Authorize>) => {
		replayResult: Replay
		prepare: (invocation: IdempotencyInvocation) => Prepare
	}
	invocation: (
		execution: WorkflowExecution<Args>,
		authority: EffectValue<Authorize>,
	) => IdempotencyInvocation
	execute: (execution: WorkflowExecution<Args>, authority: EffectValue<Authorize>) => Execute
}): EffectReceiptProtectedWorkflowMutation<
	Args,
	ContractOutput<Replay>,
	| WorkflowBindingError
	| CallbackError<Authorize | Prepare | Execute | Completion<Prepare>>
	| ContractDecoderError<Replay>,
	| CallbackRequirements<Authorize | Prepare | Execute | Completion<Prepare>>
	| ContractDecoderRequirements<Replay>
> {
	const handler = (input: WorkflowExecution<Args>) =>
		Effect.gen(function* () {
			const execution = yield* descriptor(input)
			const authority = yield* normalizeEffect(() => configuration.authorize(execution))
			const adapter = configuration.receipt(authority)
			const preparation = yield* normalizeEffect(() =>
				adapter.prepare(configuration.invocation(execution, authority)),
			)
			if (preparation.kind === 'replay')
				return yield* decodeEffectContract(adapter.replayResult, preparation.result)
			const value = yield* normalizeEffect(() => configuration.execute(execution, authority))
			// SAFETY: the execute branch came from this exact Prepare value; recover its complete callback rather than the broad constraint.
			const complete = preparation.complete as (
				result: ContractOutput<Replay>,
			) => Completion<Prepare>
			// SAFETY: Execute's supported success is the exact final replay output contract.
			yield* normalizeEffect(() => complete(value as ContractOutput<Replay>))
			// SAFETY: Execute's supported success is the exact final replay output contract.
			return value as ContractOutput<Replay>
		})
	// SAFETY: only private receipt evidence is asserted; handler's inferred E/R remain checked against the public return.
	return { handler } as ReceiptEvidence<Args, ContractOutput<Replay>, typeof handler>
}
type ReceiptEvidence<Args, Result, Handler> = {
	handler: Handler
	readonly [protectedMutation]: { args: Args; result: Result }
}
type StateResult<Read> =
	EffectValue<Read> extends WorkflowHostState<infer Result, unknown> ? Result : never
type StateFailure<Read> =
	EffectValue<Read> extends WorkflowHostState<unknown, infer Failure> ? Failure : never
/** The host still owns native manager calls and transactional/CAS writes; each method retains only its used channels. */
export function effectWorkflowStatusBindings<
	Authorize,
	Read extends Supported<WorkflowHostState>,
	Write,
	Native extends Supported<WorkflowNativeStatus>,
	Receipt extends Supported<WorkflowOutcome<StateResult<Read>, StateFailure<Read>> | undefined>,
	Cancel,
	Restart,
>(configuration: {
	authorize: () => Authorize
	read: () => Read
	write: (
		expectedGeneration: number,
		state: WorkflowHostState<StateResult<Read>, StateFailure<Read>>,
	) => Write
	nativeStatus: () => Native
	receiptOutcome: () => Receipt
	cancelNative: () => Cancel
	restartNative: () => Restart
}) {
	type State = WorkflowHostState<StateResult<Read>, StateFailure<Read>>
	function read() {
		// SAFETY: Read's supported success is the host state whose outcome types are extracted above.
		return normalizeEffect(() => configuration.read()).pipe(Effect.map((state) => state as State))
	}
	function apply(
		expectedGeneration: number,
		nativeStatus: WorkflowNativeStatus,
		outcome?: WorkflowOutcome<StateResult<Read>, StateFailure<Read>>,
	) {
		return Effect.gen(function* () {
			const current = yield* read()
			const update = { generation: expectedGeneration, nativeStatus }
			const transition = yield* protocol(() =>
				workflowTransition(current, outcome === undefined ? update : { ...update, outcome }),
			)
			if (transition.kind === 'applied')
				yield* normalizeEffect(() => configuration.write(expectedGeneration, transition.state))
			return transition
		})
	}
	return {
		callback(
			expectedGeneration: number,
			nativeStatus: WorkflowNativeStatus,
			outcome?: WorkflowOutcome<StateResult<Read>, StateFailure<Read>>,
		) {
			return normalizeEffect(() => configuration.authorize()).pipe(
				Effect.flatMap(() => apply(expectedGeneration, nativeStatus, outcome)),
			)
		},
		reconcile(expectedGeneration: number) {
			return Effect.gen(function* () {
				yield* normalizeEffect(() => configuration.authorize())
				const native = yield* normalizeEffect(() => configuration.nativeStatus())
				const outcome = yield* normalizeEffect(() => configuration.receiptOutcome())
				// SAFETY: Native and Receipt are constrained to these exact host transport values.
				return yield* apply(
					expectedGeneration,
					native as WorkflowNativeStatus,
					outcome as WorkflowOutcome<StateResult<Read>, StateFailure<Read>> | undefined,
				)
			})
		},
		cancel(expectedGeneration: number) {
			return Effect.gen(function* () {
				yield* normalizeEffect(() => configuration.authorize())
				const current = yield* read()
				const transition = yield* protocol(() => workflowCancel(current, expectedGeneration))
				if (transition.kind === 'applied' && current.status === 'running') {
					yield* normalizeEffect(() => configuration.cancelNative())
					yield* normalizeEffect(() => configuration.write(expectedGeneration, transition.state))
				}
				return transition
			})
		},
		restart(expectedGeneration: number) {
			return Effect.gen(function* () {
				yield* normalizeEffect(() => configuration.authorize())
				const current = yield* read()
				if (current.generation !== expectedGeneration)
					return { kind: 'ignored' as const, state: current }
				const state = yield* protocol(() => workflowRestart(current))
				yield* normalizeEffect(() => configuration.restartNative())
				yield* normalizeEffect(() => configuration.write(expectedGeneration, state))
				return { kind: 'applied' as const, state }
			})
		},
	}
}
function descriptor<Args>(
	value: WorkflowExecution<Args>,
): Effect.Effect<WorkflowExecution<Args>, WorkflowBindingError> {
	return protocol(() => workflowExecution(value))
}
function protocol<A>(evaluate: () => A): Effect.Effect<A, WorkflowBindingError> {
	return Effect.try({
		try: evaluate,
		catch: (error) => {
			if (error instanceof WorkflowBindingError) return error
			throw error
		},
	})
}
