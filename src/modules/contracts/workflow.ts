import type { FunctionReference, FunctionVisibility, FunctionType } from 'convex/server'
import type { WorkflowCtx } from '@convex-dev/workflow'
import {
	decodeContract,
	type ContractInput,
	type ContractOutput,
	type NeutralSchema,
} from './contract'
import {
	canonicalConvexBytes,
	captureIdempotencyInvocation,
	type CanonicalConvexBounds,
	type IdempotencyInvocation,
	type IdempotencyPreparation,
} from './idempotency'

export class WorkflowBindingError extends Error {
	readonly _tag = 'WorkflowBindingError'
	constructor(message: string) {
		super(message)
		this.name = 'WorkflowBindingError'
	}
}
export interface WorkflowExecution<Args = unknown> {
	readonly version: 1
	readonly operation: string
	readonly operationVersion: string
	readonly contractVersion: string
	readonly bindingVersion: string
	/** Host-issued business-run identity. Recovery preserves it. */
	readonly run: string
	/** Opaque host capability; never caller-supplied principal or tenant authority. */
	readonly capability: string
	/** Logical occurrence, distinct for each repeated loop step. */
	readonly occurrence: string
	readonly args: Args
}
export type WorkflowStepArguments<Args> = { execution: WorkflowExecution<Args> }
const fields = [
	'version',
	'operation',
	'operationVersion',
	'contractVersion',
	'bindingVersion',
	'run',
	'capability',
	'occurrence',
	'args',
] as const
const descriptorBounds = {
	maxDepth: 64,
	maxNodes: 100000,
	maxBytes: 1000000,
	maxArrayLength: 100000,
	maxObjectFields: 100000,
}
/** Strict plain, versioned transport. Validity does not confer authority; the host resolves capability anew. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This decoder validates an untrusted execution descriptor before it enters the native workflow boundary. */
export function workflowExecution<Args>(value: WorkflowExecution<Args>): WorkflowExecution<Args>
export function workflowExecution(value: unknown): WorkflowExecution
export function workflowExecution(value: unknown): WorkflowExecution {
	if (
		!value ||
		typeof value !== 'object' ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Reflect.ownKeys(value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(value, field))
	)
		throw new WorkflowBindingError('Execution requires exact plain descriptor fields')
	// SAFETY: the exact field set is checked above; values and accessors are checked before use below.
	const descriptor = value as WorkflowExecution
	for (const field of fields)
		if (!('value' in Object.getOwnPropertyDescriptor(value, field)!))
			throw new WorkflowBindingError('Execution cannot contain accessors')
	if (
		descriptor.version !== 1 ||
		fields
			.filter((field) => field !== 'version' && field !== 'args')
			.some((field) => typeof descriptor[field] !== 'string' || descriptor[field].length === 0)
	)
		throw new WorkflowBindingError('Invalid execution descriptor version or identity')
	try {
		canonicalConvexBytes(descriptor.args, descriptorBounds)
	} catch {
		throw new WorkflowBindingError('Execution args require plain Convex data')
	}
	return descriptor
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
export interface WorkflowBinding<
	Kind extends FunctionType,
	Args extends NeutralSchema,
	Result extends NeutralSchema,
> {
	readonly kind: Kind
	readonly operation: string
	readonly operationVersion: string
	readonly contractVersion: string
	readonly bindingVersion: string
	readonly args: Args
	readonly result: Result
	readonly reference: FunctionReference<
		NoInfer<Kind>,
		FunctionVisibility,
		WorkflowStepArguments<NoInfer<ContractInput<Args>>>,
		NoInfer<ContractInput<Result>>
	>
	/** Host explicitly lists deployed descriptor versions whose semantics remain compatible. */
	readonly compatibleVersions?: readonly {
		operationVersion: string
		contractVersion: string
		bindingVersion: string
	}[]
}
/** Both phantom reference args and results must match the explicit wire contracts. */
export function workflowBinding<
	Kind extends FunctionType,
	const Args extends NeutralSchema,
	const Result extends NeutralSchema,
>(binding: WorkflowBinding<Kind, Args, Result>): WorkflowBinding<Kind, Args, Result> {
	const compatibleVersions = binding.compatibleVersions?.map((version) =>
		Object.freeze({ ...version }),
	)
	const snapshot = { ...binding }
	if (compatibleVersions !== undefined)
		snapshot.compatibleVersions = Object.freeze(compatibleVersions)
	return Object.freeze(snapshot)
}
export type WorkflowStepOptions = {
	name?: string
	retry?: NonNullable<Parameters<WorkflowCtx['withOptions']>[0]['retry']>
} & (
	| { inline?: false; runAt?: number; runAfter?: number }
	| { inline: true; runAt?: never; runAfter?: never }
)
/** A structural seam allows invocation-scoped native WorkflowCtx without creating another durability runtime. */
export interface WorkflowStepRunner {
	/* oxlint-disable anti-slop/no-unknown-returns -- Native runner results stay opaque here; runWorkflowStep correlates them with the binding's raw result contract without replay decoding. */
	runQuery?: (
		reference: FunctionReference<'query', FunctionVisibility>,
		args: WorkflowStepArguments<unknown>,
		options?: WorkflowStepOptions,
	) => Promise<unknown>
	runMutation?: (
		reference: FunctionReference<'mutation', FunctionVisibility>,
		args: WorkflowStepArguments<unknown>,
		options?: WorkflowStepOptions,
	) => Promise<unknown>
	runAction?: (
		reference: FunctionReference<'action', FunctionVisibility>,
		args: WorkflowStepArguments<unknown>,
		options?: WorkflowStepOptions,
	) => Promise<unknown>
	/* oxlint-enable anti-slop/no-unknown-returns */
}
export async function runWorkflowStep<
	Kind extends FunctionType,
	Args extends NeutralSchema,
	Result extends NeutralSchema,
>(
	step: WorkflowCtx | WorkflowStepRunner,
	binding: WorkflowBinding<Kind, Args, Result>,
	input: WorkflowExecution<ContractInput<Args>>,
	options: WorkflowStepOptions = {},
): Promise<ContractInput<Result>> {
	// SAFETY: each binding has nonempty, checked generated args. Native ArgsAndOptions' empty-args overload is never selected.
	const runner = step as WorkflowStepRunner
	const execution = workflowExecution(input)
	const versions = [binding, ...(binding.compatibleVersions ?? [])]
	if (
		execution.operation !== binding.operation ||
		!versions.some(
			(version) =>
				version.operationVersion === execution.operationVersion &&
				version.contractVersion === execution.contractVersion &&
				version.bindingVersion === execution.bindingVersion,
		)
	)
		throw new WorkflowBindingError('Incompatible workflow operation version')
	const nativeOptions = {
		...options,
		name: options.name ?? `${execution.operation}:${execution.occurrence}`,
	}
	let output: unknown
	switch (binding.kind) {
		case 'query':
			if (!runner.runQuery) throw new WorkflowBindingError('Native query runner missing')
			// SAFETY: the checked binding kind selects this exact native reference kind.
			output = await runner.runQuery(
				binding.reference as FunctionReference<'query', FunctionVisibility>,
				{ execution },
				nativeOptions,
			)
			break
		case 'mutation':
			if (!runner.runMutation) throw new WorkflowBindingError('Native mutation runner missing')
			// SAFETY: the checked binding kind selects this exact native reference kind.
			output = await runner.runMutation(
				binding.reference as FunctionReference<'mutation', FunctionVisibility>,
				{ execution },
				nativeOptions,
			)
			break
		case 'action':
			if (!runner.runAction) throw new WorkflowBindingError('Native action runner missing')
			if (options.inline) throw new WorkflowBindingError('Actions cannot execute inline')
			// SAFETY: the checked binding kind selects this exact native reference kind.
			output = await runner.runAction(
				binding.reference as FunctionReference<'action', FunctionVisibility>,
				{ execution },
				{ ...nativeOptions, retry: options.retry ?? false },
			)
			break
	}
	// Native validators own wire validation. Replaying workflow code must not rerun transforms.
	// SAFETY: the binding correlates the generated reference's result with this raw wire contract.
	return output as ContractInput<Result>
}
export async function workflowDecode<S extends NeutralSchema>(
	schema: S,
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The schema parses retained or native transport values at this boundary.
	value: unknown,
): Promise<ContractOutput<S>> {
	const decoded = await decodeContract(schema, value)
	if (decoded.issues) throw new WorkflowBindingError('Workflow contract validation failed')
	return decoded.value
}
type Ordinary<A> = A | PromiseLike<A>
/** This helper belongs inside a registered native function, never in the replaying workflow handler. */
export function workflowAttempt<Args, Authority, Result>(configuration: {
	authorize: (execution: WorkflowExecution<Args>) => Ordinary<Authority>
	execute: (execution: WorkflowExecution<Args>, authority: Authority) => Ordinary<Result>
}) {
	return async (input: WorkflowExecution<Args>): Promise<Result> => {
		const execution = workflowExecution(input)
		const authority = await configuration.authorize(execution)
		return configuration.execute(execution, authority)
	}
}
export type WorkflowOutcome<Result = unknown, Failure = unknown> =
	| { readonly version: 1; readonly kind: 'succeeded'; readonly value: Result }
	| { readonly version: 1; readonly kind: 'failed'; readonly error: Failure }
declare const protectedMutation: unique symbol
export interface ReceiptProtectedWorkflowMutation<Args, Result> {
	readonly [protectedMutation]: { args: Args; result: Result }
	readonly handler: (execution: WorkflowExecution<Args>) => Promise<Result>
}
export interface WorkflowReceiptAdapter<S extends NeutralSchema> {
	readonly replayResult: S
	readonly prepare: (
		invocation: IdempotencyInvocation,
	) => Promise<IdempotencyPreparation<ContractOutput<S>>>
}
/** Host registers this handler as the inner native mutation. All callbacks share its transaction. */
export function receiptWorkflowMutation<
	Args,
	Authority,
	const Replay extends NeutralSchema,
>(configuration: {
	authorize: (execution: WorkflowExecution<Args>) => Ordinary<Authority>
	receipt: (authority: Authority) => WorkflowReceiptAdapter<Replay>
	invocation: (execution: WorkflowExecution<Args>, authority: Authority) => IdempotencyInvocation
	execute: (
		execution: WorkflowExecution<Args>,
		authority: Authority,
	) => Ordinary<ContractOutput<Replay>>
}): ReceiptProtectedWorkflowMutation<Args, ContractOutput<Replay>> {
	const handler = workflowAttempt({
		authorize: configuration.authorize,
		execute: async (execution: WorkflowExecution<Args>, authority: Authority) => {
			const adapter = configuration.receipt(authority)
			const preparation = await adapter.prepare(configuration.invocation(execution, authority))
			if (preparation.kind === 'replay')
				return workflowDecode(adapter.replayResult, preparation.result)
			const value = await configuration.execute(execution, authority)
			await preparation.complete(value)
			return value
		},
	})
	// SAFETY: the private type evidence can only be issued by this receipt-protected helper.
	return { handler } as ReceiptProtectedWorkflowMutation<Args, ContractOutput<Replay>>
}
export function workflowReceiptInvocation(
	execution: WorkflowExecution,
	options: { scope: string; fingerprintPolicy: string; bounds: CanonicalConvexBounds },
): IdempotencyInvocation {
	const descriptor = workflowExecution(execution)
	return captureIdempotencyInvocation({
		binding: { kind: 'mutation', atomicity: 'same-mutation' },
		identity: {
			operation: descriptor.operation,
			scope: options.scope,
			key: JSON.stringify([descriptor.run, descriptor.occurrence]),
		},
		versions: {
			operation: descriptor.operationVersion,
			contract: descriptor.contractVersion,
			binding: descriptor.bindingVersion,
			fingerprintPolicy: options.fingerprintPolicy,
		},
		rawInput: descriptor.args,
		canonical: { bounds: options.bounds },
	})
}
type TerminalMode<Args> =
	| {
			kind: 'mutation'
			/** Assertion supplied only after host native rollback/journaling acceptance. */ atomicJournalProof: 'host-verified'
	  }
	| { kind: 'action'; protectedMutation: ReceiptProtectedWorkflowMutation<Args, unknown> }
/** The native inner mutation rejection must cross its transaction boundary before terminal mapping. */
export function terminalWorkflowAttempt<
	Args,
	Authority,
	const Result extends NeutralSchema,
	const Failure extends NeutralSchema,
>(
	configuration: TerminalMode<Args> & {
		authorize: (execution: WorkflowExecution<Args>) => Ordinary<Authority>
		invokeMutation: (
			execution: WorkflowExecution<Args>,
			authority: Authority,
		) => Promise<ContractInput<Result>>
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native thrown values are classified by the host before validating the terminal failure contract.
		terminal: (error: unknown) => Ordinary<ContractInput<Failure> | undefined>
		result: Result
		failure: Failure
	},
) {
	return workflowAttempt({
		authorize: configuration.authorize,
		execute: async (
			execution: WorkflowExecution<Args>,
			authority: Authority,
		): Promise<WorkflowOutcome<ContractInput<Result>, ContractOutput<Failure>>> => {
			let value: ContractInput<Result>
			try {
				value = await configuration.invokeMutation(execution, authority)
			} catch (error) {
				const terminal = await configuration.terminal(error)
				if (terminal === undefined) throw error
				const safeFailure = await workflowDecode(configuration.failure, terminal)
				canonicalConvexBytes(safeFailure, descriptorBounds)
				return { version: 1, kind: 'failed', error: safeFailure }
			}
			await workflowDecode(configuration.result, value)
			canonicalConvexBytes(value, descriptorBounds)
			return { version: 1, kind: 'succeeded', value }
		},
	})
}
export type WorkflowNativeStatus = 'running' | 'succeeded' | 'failed' | 'canceled'
export interface WorkflowHostState<Result = unknown, Failure = unknown> {
	readonly generation: number
	readonly status: WorkflowNativeStatus
	readonly nativeStatus: WorkflowNativeStatus
	readonly outcome?: WorkflowOutcome<Result, Failure>
}
export interface WorkflowHostUpdate<Result = unknown, Failure = unknown> {
	readonly generation: number
	readonly nativeStatus: WorkflowNativeStatus
	readonly outcome?: WorkflowOutcome<Result, Failure>
}
export type WorkflowTransition<Result = unknown, Failure = unknown> = {
	readonly kind: 'applied' | 'ignored'
	readonly state: WorkflowHostState<Result, Failure>
}
/** Call within a host transaction or compare-and-set. A late operation failure refines host success; cancellation and terminal native status stay fenced. */
export function workflowTransition<Result, Failure>(
	current: WorkflowHostState<Result, Failure>,
	update: WorkflowHostUpdate<Result, Failure>,
): WorkflowTransition<Result, Failure> {
	generation(current.generation)
	generation(update.generation)
	if (current.generation !== update.generation) return { kind: 'ignored', state: current }
	const nativeStatus =
		current.nativeStatus !== 'running' ? current.nativeStatus : update.nativeStatus
	const outcome = current.outcome ?? update.outcome
	const status =
		(current.status === 'running' || current.status === 'succeeded') &&
		nativeStatus === 'succeeded' &&
		outcome?.kind === 'failed'
			? 'failed'
			: current.status !== 'running'
				? current.status
				: nativeStatus
	const state = { generation: current.generation, status, nativeStatus }
	return { kind: 'applied', state: outcome === undefined ? state : { ...state, outcome } }
}
export function workflowCancel<Result, Failure>(
	current: WorkflowHostState<Result, Failure>,
	expectedGeneration: number,
): WorkflowTransition<Result, Failure> {
	generation(expectedGeneration)
	if (current.generation !== expectedGeneration) return { kind: 'ignored', state: current }
	return {
		kind: 'applied',
		state: { ...current, status: current.status === 'running' ? 'canceled' : current.status },
	}
}
/** Host calls after an authorized native restart. Receipt identity remains run plus occurrence. */
export function workflowRestart<Result, Failure>(
	current: WorkflowHostState<Result, Failure>,
): WorkflowHostState<Result, Failure> {
	generation(current.generation)
	generation(current.generation + 1)
	const state = {
		generation: current.generation + 1,
		status: 'running' as const,
		nativeStatus: 'running' as const,
	}
	return current.outcome?.kind === 'succeeded' ? { ...state, outcome: current.outcome } : state
}
/** Host closures capture the trusted run, secured storage and manager. `write` must enforce expected generation atomically. */
export function workflowStatusBindings<Result, Failure>(configuration: {
	authorize: () => Ordinary<void>
	read: () => Ordinary<WorkflowHostState<Result, Failure>>
	write: (expectedGeneration: number, state: WorkflowHostState<Result, Failure>) => Ordinary<void>
	nativeStatus: () => Ordinary<WorkflowNativeStatus>
	receiptOutcome: () => Ordinary<WorkflowOutcome<Result, Failure> | undefined>
	/** Host calls the manager in the same transaction as its guarded state write. */
	cancelNative: () => Ordinary<void>
	restartNative: () => Ordinary<void>
}) {
	async function apply(
		expectedGeneration: number,
		nativeStatus: WorkflowNativeStatus,
		outcome?: WorkflowOutcome<Result, Failure>,
	) {
		const update = { generation: expectedGeneration, nativeStatus }
		const transition = workflowTransition(
			await configuration.read(),
			outcome === undefined ? update : { ...update, outcome },
		)
		if (transition.kind === 'applied')
			await configuration.write(expectedGeneration, transition.state)
		return transition
	}
	return {
		async callback(
			expectedGeneration: number,
			nativeStatus: WorkflowNativeStatus,
			outcome?: WorkflowOutcome<Result, Failure>,
		) {
			await configuration.authorize()
			return apply(expectedGeneration, nativeStatus, outcome)
		},
		async reconcile(expectedGeneration: number) {
			await configuration.authorize()
			return apply(
				expectedGeneration,
				await configuration.nativeStatus(),
				await configuration.receiptOutcome(),
			)
		},
		async cancel(expectedGeneration: number) {
			await configuration.authorize()
			const current = await configuration.read()
			const transition = workflowCancel(current, expectedGeneration)
			if (transition.kind === 'applied' && current.status === 'running') {
				await configuration.cancelNative()
				await configuration.write(expectedGeneration, transition.state)
			}
			return transition
		},
		async restart(expectedGeneration: number) {
			await configuration.authorize()
			const current = await configuration.read()
			if (current.generation !== expectedGeneration)
				return { kind: 'ignored' as const, state: current }
			const state = workflowRestart(current)
			await configuration.restartNative()
			await configuration.write(expectedGeneration, state)
			return { kind: 'applied' as const, state }
		},
	}
}
function generation(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new WorkflowBindingError('Invalid host execution generation')
}
