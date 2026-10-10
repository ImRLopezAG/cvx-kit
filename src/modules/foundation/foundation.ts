/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Private heterogeneous executor storage; public overloads restore schema-owned values and callbacks before dispatch. */
import type { AuditEntryInput } from '../../components/foundation/client'
// oxlint-disable-next-line cvx/component-boundaries -- SAFETY: Host registries share the deployed component's Effect-free interpreter.
import {
	executeCommandLifecycle,
	promiseLifecycle,
	CommandPermissionError,
	type PromiseExecution,
} from '../../components/foundation/modules/command/lifecycle'
// oxlint-disable-next-line cvx/component-boundaries -- SAFETY: Host-only observability is shared without entering the deployment graph.
import {
	Observability,
	type ObservabilityOptions,
} from '../../components/foundation/modules/observability/observability'
import {
	decodeContract,
	type ContractInput,
	type ContractOutput,
	type NeutralSchema,
} from '../contracts/contract'
import type { DomainContract, DomainAuditInput } from '../contracts/domain'
import { snapshotOperations } from '../contracts/binding'
import {
	selectOperation,
	type SelectedOperation,
	type OperationPublicResult,
} from '../contracts/exposure'
import {
	domainFactory,
	operationFactory,
	type DomainFactory,
	type InlineFactory,
	type NormalEntry,
	type Audit,
	type CheckedOperation,
	type ExactOperations,
	type ValidatedOperations,
} from './operation'

type Supported<Value> = Value | PromiseLike<Value>
type Resolver = (host: never) => unknown
type Domain<Resolve extends Resolver> = Awaited<ReturnType<Resolve>>
type Host<Resolve extends Resolver> = Parameters<Resolve>[0]
type CallbackHost<Callback> = Callback extends (host: infer Host, ...args: never[]) => unknown
	? Host
	: unknown
export type FoundationRegistryOptions = {
	observability: ObservabilityOptions
	writeAudit: (host: never, entry: AuditEntryInput) => Supported<unknown>
	checkPermission?: (
		host: never,
		input: { operation: string; permission: string },
	) => Supported<void>
}
type Registry<Context> = Readonly<
	Record<
		string,
		NormalEntry & { handler: (input: never, context: never) => unknown } & CheckedOperation<Context>
	>
>
type AuditedRegistry<Context> = Registry<Context> &
	Readonly<Record<string, { audit: (resolution: never, context: never) => Supported<Audit> }>>
type Defaults<Context> = { guard?: (context: Context) => Supported<void>; metadata?: object }
export type FoundationRegistry<
	Resolve extends Resolver,
	Operations extends Registry<Domain<Resolve>>,
> = {
	exec<Key extends Extract<keyof Operations, string>>(
		operation: Key,
		input: ContractInput<Operations[Key]['input']>,
		host: Host<Resolve>,
	): Promise<ContractOutput<Operations[Key]['result']>>
	withContext(host: Host<Resolve>): {
		exec<Key extends Extract<keyof Operations, string>>(
			operation: Key,
			input: ContractInput<Operations[Key]['input']>,
		): Promise<ContractOutput<Operations[Key]['result']>>
	}
	expose<const Owner extends symbol, const Key extends Extract<keyof Operations, string>>(
		owner: Owner,
		operation: Key,
	): SelectedOperation<Owner, Key, Operations[Key]['input'], OperationPublicResult<Operations[Key]>>
}
type RuntimeDefinition = NormalEntry & {
	classification?: string
	permission?: string
	metadata?: object
	aggregates?: readonly string[]
	handler: (input: unknown, context: unknown) => Supported<unknown>
	guard?: (context: unknown, input: unknown) => Supported<void>
	prepare?: (
		context: unknown,
		input: unknown,
	) => Supported<
		| { kind: 'replay'; result: unknown }
		| { kind: 'execute'; complete?: (result: unknown) => Supported<void> }
	>
	audit: (resolution: { command: unknown; result: unknown }, context: unknown) => Supported<Audit>
	middleware?: (input: {
		operation: string
		command: unknown
		input: unknown
		context: unknown
		metadata: object
		next: (options?: { context?: object }) => Promise<unknown>
	}) => Supported<unknown>
}
type RuntimeConfiguration = {
	context: Resolver
	contract?: DomainContract
	operations: (definitions: never) => Readonly<Record<string, object>>
	audit?: (resolution: never, context: never) => Supported<Audit>
	defaults?: Defaults<never>
}

// SAFETY: public helper signatures and the paired schema check this erased runtime invocation.
/** Promise-based registries share the same command protocol as the optional Effect adapter. */
export function createFoundation<const Options extends FoundationRegistryOptions>(
	options: Options,
) {
	const observability = new Observability(options.observability)
	type PolicyHost = CallbackHost<Options['writeAudit']> & CallbackHost<Options['checkPermission']>
	type Compatible<Resolve extends Resolver> =
		Host<Resolve> extends PolicyHost ? unknown : { context: never }
	function Command<
		Resolve extends Resolver,
		const Contract extends DomainContract & {
			commands: Readonly<Record<string, NormalEntry & { classification: string }>>
		},
		const Operations extends Registry<Domain<Resolve>>,
	>(
		configuration: {
			contract: Contract
			context: Resolve
			audit: (
				resolution: DomainAuditInput<Contract['commands']>,
				context: Domain<Resolve>,
			) => Supported<Audit>
			operations: (
				definitions: DomainFactory<Domain<Resolve>, Contract['commands'], true, false>,
			) => Operations &
				NoInfer<ExactOperations<Operations, Contract['commands']>> &
				NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Command<
		Resolve extends Resolver,
		const Contract extends DomainContract & {
			commands: Readonly<Record<string, NormalEntry & { classification: string }>>
		},
		const Operations extends AuditedRegistry<Domain<Resolve>>,
	>(
		configuration: {
			contract: Contract
			context: Resolve
			audit?: never
			operations: (
				definitions: DomainFactory<Domain<Resolve>, Contract['commands'], true, true>,
			) => Operations &
				NoInfer<ExactOperations<Operations, Contract['commands']>> &
				NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Command<Resolve extends Resolver, const Operations extends Registry<Domain<Resolve>>>(
		configuration: {
			contract?: never
			context: Resolve
			audit: (
				resolution: DomainAuditInput<Operations>,
				context: Domain<Resolve>,
			) => Supported<Audit>
			operations: (
				definitions: InlineFactory<Domain<Resolve>, false>,
			) => Operations & NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Command<
		Resolve extends Resolver,
		const Operations extends AuditedRegistry<Domain<Resolve>>,
	>(
		configuration: {
			contract?: never
			context: Resolve
			operations: (
				definitions: InlineFactory<Domain<Resolve>, true>,
			) => Operations & NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Command(configuration: RuntimeConfiguration): unknown {
		return registry(configuration, true)
	}
	function Query<
		Resolve extends Resolver,
		const Contract extends DomainContract & { queries: Readonly<Record<string, NormalEntry>> },
		const Operations extends Registry<Domain<Resolve>>,
	>(
		configuration: {
			contract: Contract
			context: Resolve
			operations: (
				definitions: DomainFactory<Domain<Resolve>, Contract['queries'], false, true>,
			) => Operations &
				NoInfer<ExactOperations<Operations, Contract['queries']>> &
				NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Query<Resolve extends Resolver, const Operations extends Registry<Domain<Resolve>>>(
		configuration: {
			contract?: never
			context: Resolve
			operations: (
				definitions: InlineFactory<Domain<Resolve>, true>,
			) => Operations & NoInfer<ValidatedOperations<Operations>>
			defaults?: Defaults<Domain<Resolve>>
		} & Compatible<Resolve>,
	): FoundationRegistry<Resolve, Operations>
	function Query(configuration: RuntimeConfiguration): unknown {
		return registry(configuration, false)
	}
	function registry(configuration: RuntimeConfiguration, command: boolean) {
		const section = command ? 'commands' : 'queries'
		// SAFETY: public overloads restrict Promise registries to neutral schemas.
		const definitions = configuration.contract
			? domainFactory(
					// SAFETY: public helper signatures and the paired schema check this erased runtime invocation.
					(configuration.contract[section] as Readonly<Record<string, NormalEntry>>) ?? {},
					command,
				)
			: operationFactory()
		// SAFETY: helper overloads checked the selected callbacks; storage erases only their parameters.
		const operations = snapshotOperations(
			// SAFETY: public helper signatures and the paired schema check this erased runtime invocation.
			configuration.operations(definitions as never),
			configuration.contract,
			section,
			configuration.audit,
		)
		async function exec(operation: string, input: unknown, host: never) {
			if (!Object.hasOwn(operations, operation))
				throw Error(`The selected ${command ? 'command' : 'query'} operation is not configured`)
			// SAFETY: helpers verified callbacks against these paired schemas; only the runtime storage erases values.
			const definition = operations[operation] as RuntimeDefinition
			const parsed = await decode(definition.input, input)
			return observability.observe(
				{ operation, classification: definition.classification ?? 'query' },
				async () => {
					const permission = async () => {
						if (!definition.permission) return
						if (!options.checkPermission) throw new CommandPermissionError(operation)
						await options.checkPermission(host, { operation, permission: definition.permission })
					}
					if (!command) await permission()
					const context = await configuration.context(host)
					const run = (enriched: unknown) => Promise.resolve(definition.handler(parsed, enriched))
					const guard = async (enriched: unknown) => {
						// SAFETY: base resolver context is the public default guard context.
						await configuration.defaults?.guard?.(enriched as never)
						await definition.guard?.(enriched, parsed)
					}
					if (command)
						return executeCommandLifecycle<PromiseExecution, unknown, unknown, unknown, unknown>(
							promiseLifecycle,
							{
								operation,
								classification: definition.classification!,
								context,
								command: parsed,
								permission,
								prepare: async () => {
									const prepared = await definition.prepare?.(context, parsed)
									return prepared?.kind === 'execute'
										? {
												...prepared,
												complete: prepared.complete
													? async (result) => {
															await prepared.complete!(result)
														}
													: undefined,
											}
										: prepared
								},
								middleware: definition.middleware
									? [
											(input) =>
												Promise.resolve(
													definition.middleware!({
														...input,
														input: parsed,
														metadata: {
															...configuration.defaults?.metadata,
															...definition.metadata,
														},
													}),
												),
										]
									: [],
								defaultGuard: async () => {},
								guard,
								run,
								decodeReplay: (value) =>
									decode(definition.replayResult ?? definition.result, value),
								decodeResult: (value) => decode(definition.result, value),
								audit: async (result) => definition.audit({ command: parsed, result }, context),
								writeAudit: async (entry) => options.writeAudit(host, entry),
								aggregates: definition.aggregates,
							},
						)
					let called = false
					const next = async (enriched = context) => {
						if (called) throw Error('A query middleware called next() more than once')
						called = true
						await guard(enriched)
						return run(enriched)
					}
					const raw = definition.middleware
						? await definition.middleware({
								operation,
								command: parsed,
								input: parsed,
								context,
								metadata: { ...configuration.defaults?.metadata, ...definition.metadata },
								next: (settings) =>
									next(
										// SAFETY: public helper signatures and the paired schema check this erased runtime invocation.
										settings?.context ? { ...(context as object), ...settings.context } : context,
									),
							})
						: await next()
					return decode(definition.result, raw)
				},
			)
		}
		return {
			exec,
			withContext: (host: never) => ({
				exec: (operation: string, input: unknown) => exec(operation, input, host),
			}),
			expose: (owner: symbol, operation: string) => {
				if (!Object.hasOwn(operations, operation))
					throw Error('The selected operation is not configured')
				return selectOperation(
					owner,
					command ? 'mutation' : 'query',
					operation,
					// SAFETY: public helper signatures and the paired schema check this erased runtime invocation.
					operations[operation] as RuntimeDefinition,
				)
			},
		}
	}
	return { Command, Query, observability }
}

async function decode(schema: NeutralSchema, value: unknown) {
	if ('kind' in schema && schema.kind !== 'contract')
		throw Error('Effect contracts require the Effect registry')
	const decoded = await decodeContract(schema, value)
	if (decoded.issues) throw Error(decoded.issues.map((issue) => issue.message).join('; '))
	return decoded.value
}
