import type { ContractSchema, ContractInput, ContractOutput } from './contract'
import type { ErrorContract, ErrorDefinitions } from './errors'

/** Schema-only domain vocabulary; implementations and host policies live in registries. */
export type DomainOperationContract = {
	readonly input: ContractSchema
	readonly result: ContractSchema
	readonly classification?: string
	readonly wire?: { readonly schema: ContractSchema; readonly project: Function }
}
export type DomainCommandContract = DomainOperationContract & {
	readonly classification: string
	readonly replayResult?: ContractSchema
}
export type DomainQueryContract = DomainOperationContract & { readonly replayResult?: never }
export type DomainContract = {
	readonly errors?: Pick<ErrorContract<ErrorDefinitions>, 'project'>
	readonly commands?: Readonly<Record<string, DomainCommandContract>>
	readonly queries?: Readonly<Record<string, DomainQueryContract>>
}

type CheckedEntry<Entry extends DomainOperationContract> = {
	readonly handler?: never
	readonly audit?: never
	readonly prepare?: never
	readonly guard?: never
	readonly middleware?: never
	readonly context?: never
	readonly wire?: Entry extends { wire: { schema: infer Wire } }
		? {
				readonly schema: Wire
				readonly project: (value: ContractOutput<Entry['result']>) => ContractInput<Wire>
			}
		: never
} & (Entry extends { replayResult: infer Replay }
	? {
			readonly replayResult: ContractOutput<Replay> extends ContractOutput<Entry['result']>
				? Replay
				: never
		}
	: {})
type CheckedSection<Section> = {
	readonly [Key in keyof Section]: Section[Key] extends DomainOperationContract
		? CheckedEntry<Section[Key]>
		: never
}
type CheckedDomain<Definition> = {
	readonly [Section in Extract<keyof Definition, 'commands' | 'queries'>]: CheckedSection<
		Definition[Section]
	>
}

/** Preserve the declaration's literal keys and opaque validator/error-contract identities. */
export function defineDomainContract<const Definition extends DomainContract>(
	definition: Definition & NoInfer<CheckedDomain<Definition>>,
): Definition {
	return definition
}

/** Exactness applies to variables as well as fresh object literals. */
export type ExactOperationKeys<Operations, Contracts> =
	Exclude<keyof Operations, keyof Contracts> extends never
		? Exclude<keyof Contracts, keyof Operations> extends never
			? string extends keyof Contracts
				? never
				: unknown
			: never
		: never

/** Correlated callback envelope for registry-level command audit. */
export type DomainAuditInput<Commands> = {
	[Key in Extract<keyof Commands, string>]: Commands[Key] extends DomainOperationContract
		? {
				operation: Key
				input: ContractOutput<Commands[Key]['input']>
				result: ContractOutput<Commands[Key]['result']>
			}
		: never
}[Extract<keyof Commands, string>]
