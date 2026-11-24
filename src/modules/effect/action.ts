/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Overload implementation storage is erased; public signatures retain concrete values, errors and services. */
import type { Effect } from 'effect'
import type { AuditEntryInput } from '../../components/foundation/client'
// oxlint-disable-next-line cvx/component-boundaries -- SAFETY: Internal optional adapter shares the Effect-free Foundation observability without entering the Convex component deployment graph.
import type { Observability } from '../../components/foundation/modules/observability/observability'
import type { DomainAuditInput, DomainContract } from '../contracts/domain'
import { snapshotOperations } from '../contracts/binding'
import { memoize, registerLazyRegistry } from '../contracts/lazy'
import {
	createEffectCommand,
	type DomainOf,
	type HostOf,
	type HostParameter,
	type Registry,
	type Resolver,
} from './command'
import type { AuditedOperations, AuditValue } from './domain'
import type { FailureAuditOptions } from './failure-audit'
import {
	effectActionFactory,
	type CallbackError,
	type CallbackRequirements,
	type ValidatedEffectOperations,
} from './operation'
import type { NestedAuditMode, RequestScope } from './scope'

type Supported<Value> = Value | PromiseLike<Value> | Effect.Effect<Value, unknown, unknown>

/** Host policies an Action registry uses; actions have no mutation-side permission host. */
export type EffectActionDependencies = {
	observability: Observability
	/** Writes action audit entries, typically through `ctx.runMutation`; required once any action audits. */
	writeActionAudit?: (host: never, entry: AuditEntryInput) => Supported<unknown>
	auditFailure?: FailureAuditOptions
	nestedAudit?: NestedAuditMode
}
type ActionWriter<Dependencies extends EffectActionDependencies> = [
	Exclude<Dependencies['writeActionAudit'], undefined>,
] extends [never]
	? (host: never, entry: AuditEntryInput) => void
	: Exclude<Dependencies['writeActionAudit'], undefined>
/** The command kernel runs actions with the action writer in its audit-writer slot. */
type KernelDependencies<Dependencies extends EffectActionDependencies> = {
	observability: Observability
	writeAudit: ActionWriter<Dependencies>
	auditFailure?: FailureAuditOptions
	nestedAudit?: NestedAuditMode
}
type ActionCompatible<Resolve extends Resolver, Dependencies extends EffectActionDependencies> = [
	HostOf<Resolve>,
] extends [HostParameter<Dependencies['writeActionAudit']>]
	? unknown
	: { context: never }
type ActionFactory<Resolve extends Resolver, Guard> = ReturnType<
	typeof effectActionFactory<
		DomainOf<Resolve>,
		NoInfer<CallbackError<Guard>>,
		NoInfer<CallbackRequirements<Guard>>
	>
>
type Kernel<
	Resolve extends Resolver,
	Operations extends Registry<DomainOf<Resolve>>,
	Dependencies extends EffectActionDependencies,
	Guard,
> = ReturnType<
	typeof createEffectCommand<Resolve, Operations, KernelDependencies<Dependencies>, Guard>
>
/** Actions are executed by their own Convex action functions; they are never exposed as mutations. */
export type EffectActionRegistry<
	Resolve extends Resolver,
	Operations extends Registry<DomainOf<Resolve>>,
	Dependencies extends EffectActionDependencies,
	Guard,
> = Pick<Kernel<Resolve, Operations, Dependencies, Guard>, 'exec' | 'withContext'>

export class ActionAuditWriterError extends Error {
	readonly code = 'ACTION_AUDIT_WRITER_MISSING'
	readonly name = 'ActionAuditWriterError'
	constructor(operation: string) {
		super(`Action "${operation}" declares an audit but the Foundation has no writeActionAudit`)
	}
}

/** Bind trusted application policies once; each registry resolves its own invocation context. */
export function bindEffectAction<const Dependencies extends EffectActionDependencies>(
	dependencies: Dependencies,
) {
	function action<
		Resolve extends Resolver,
		const Operations extends Registry<DomainOf<Resolve>>,
		Returned extends AuditValue = never,
		Guard = never,
	>(
		configuration: {
			context: Resolve
			audit?: (
				resolution: DomainAuditInput<Operations>,
				context: DomainOf<Resolve>,
				scope: RequestScope | undefined,
			) => Returned
			operations: (
				define: ActionFactory<Resolve, Guard>,
			) => Operations & NoInfer<ValidatedEffectOperations<Operations>>
			defaults?: { guard?: (context: DomainOf<Resolve>) => Guard }
		} & ActionCompatible<Resolve, Dependencies>,
	): EffectActionRegistry<
		Resolve,
		[Returned] extends [never]
			? Operations
			: AuditedOperations<Operations, (resolution: never, context: never) => Returned>,
		Dependencies,
		Guard
	>
	function action(configuration: {
		context: Resolver
		contract?: DomainContract
		audit?: (resolution: never, context: never, scope: never) => AuditValue
		operations: (define: never) => Readonly<Record<string, object>>
		defaults?: { guard?: (context: never) => unknown }
	}): unknown {
		const buildOperations = () => {
			const operations = snapshotOperations(
				configuration.operations(
					// SAFETY: the overload checks callbacks against this exact helper factory.
					effectActionFactory() as never,
				),
				configuration.contract,
				'actions',
				configuration.audit,
			)
			if (!dependencies.writeActionAudit) {
				for (const [operation, definition] of Object.entries(operations))
					if ('audit' in definition && definition.audit !== undefined)
						throw new ActionAuditWriterError(operation)
			}
			return operations
		}
		const getOperations = memoize(buildOperations)
		// SAFETY: overloads check callbacks and schemas; binding validates exact keys and snapshots runtime records.
		const kernel = createEffectCommand({
			...configuration,
			observability: dependencies.observability,
			auditFailure: dependencies.auditFailure,
			nestedAudit: dependencies.nestedAudit,
			writeAudit: dependencies.writeActionAudit ?? (() => undefined),
			operations: getOperations,
			mode: 'action',
		} as never)
		return registerLazyRegistry(
			{ exec: kernel.exec, withContext: kernel.withContext },
			getOperations,
		)
	}
	return action
}
