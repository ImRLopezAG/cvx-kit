import { Effect } from 'effect'
import type { GenericId } from 'convex/values'
import type { PaginationOptions, PaginationResult } from 'convex/server'
import { z } from 'zod'
import { paginated, zid } from '../../zod-table'
import { defaultErrors } from '../../errors'
import type { EffectFoundation, EffectFoundationOptions } from './foundation'
// oxlint-disable-next-line cvx/component-boundaries -- SAFETY: Match the bound Foundation's concrete observability dependency without changing its lifecycle.
import type { Observability } from '../../components/foundation/modules/observability/observability'
import { normalizeEffect } from './normalize'
import {
	effectOperationFactory,
	type CallbackError,
	type CallbackRequirements,
	type EffectValue,
	type EffectOperationArgument,
	type EffectOperationResult,
	type EffectOperationError,
	type EffectOperationRequirements,
	type UnwrappedDefaultError,
	type UnwrappedDefaultRequirements,
} from './operation'
import type { ContractSchema, LegacyParser, StandardSchema } from '../contracts/contract'

/** Table masks and branded IDs come from the same kit-owned table boundary. */
export type EffectCrudTable = {
	tableName: string
	commandInput: z.ZodObject<Record<string, z.ZodType>>
	storage: z.ZodObject<Record<string, z.ZodType>>
	publicDto: z.ZodObject<Record<string, z.ZodType>>
	tools: {
		id: z.ZodObject<{ id: z.ZodType<GenericId<string>, string> }>
		update: z.ZodObject<{
			id: z.ZodType<GenericId<string>, string>
			data: z.ZodObject<Record<string, z.ZodType>>
		}>
	}
}
type Input<Table extends EffectCrudTable> = z.output<Table['commandInput']>
type Storage<Table extends EffectCrudTable> = z.input<Table['storage']>
type Id<Table extends EffectCrudTable> = GenericId<Table['tableName']>
type Update<Table extends EffectCrudTable> = z.output<Table['tools']['update']>
type IdInput<Table extends EffectCrudTable> = z.output<Table['tools']['id']>
type IdContext<Table extends EffectCrudTable> = {
	db: { normalizeId: (table: Table['tableName'], id: string) => Id<Table> | null }
}
/** Compare decoded command fields with storage input, allowing server-only fields. */
type StorageCompatible<Decoded, Stored> = [Exclude<keyof Decoded, keyof Stored>] extends [never]
	? [Decoded] extends [Pick<Partial<Stored>, Extract<keyof Decoded, keyof Stored>>]
		? true
		: false
	: false
// Presence only: callback return inference belongs to the existing overrides signature.
type StorageOverrides<Table extends EffectCrudTable> = (StorageCompatible<
	Input<Table>,
	Storage<Table>
> extends true
	? unknown
	: { overrides: { create: Function } }) &
	(StorageCompatible<Update<Table>['data'], Storage<Table>> extends true
		? unknown
		: { overrides: { update: Function } })
type Supported<Value> = Value | PromiseLike<Value> | Effect.Effect<Value, unknown, unknown>
export type EffectCrudPage<Row> = PaginationResult<Row>
// Materialize the native interface so the alias also satisfies Convex's function-args constraint.
export type EffectCrudPagination = {
	[Key in keyof PaginationOptions]: PaginationOptions[Key]
} & { id?: number }
/** Trusted repositories receive domain context, never authority from caller arguments. */
export type EffectCrudRepository<Context, Table extends EffectCrudTable, Insert, Patch> = {
	insert: (context: Context, values: Storage<Table>) => Insert
	patch: (context: Context, id: Id<Table>, values: Partial<Storage<Table>>) => Patch
}
export type EffectCrudContext<Table extends EffectCrudTable> = {
	db: {
		insert: (table: Table['tableName'], values: Storage<Table>) => Promise<Id<Table>>
		patch: (id: Id<Table>, values: Partial<Storage<Table>>) => Promise<void>
	}
}
/* oxlint-disable anti-slop/no-unknown-returns -- Type-only host extraction; the bound Foundation retains the callbacks and their concrete return channels. */
type CallbackHost<Callback> = [Exclude<Callback, undefined>] extends [never]
	? unknown
	: Exclude<Callback, undefined> extends (...args: infer Arguments) => unknown
		? Arguments extends []
			? unknown
			: Arguments[0]
		: unknown
type PermissionPolicy<Dependencies> = 'checkPermission' extends keyof Dependencies
	? Dependencies['checkPermission']
	: never
type CallbackReturned<Callback> = Callback extends (...args: never[]) => infer Returned
	? Returned
	: never
type QueryCallbackHost<Callback> = Callback extends (host: infer Host, input: never) => unknown
	? Host
	: never
type QueryPolicyHost<Dependencies> = [QueryCallbackHost<PermissionPolicy<Dependencies>>] extends [
	never,
]
	? unknown
	: QueryCallbackHost<PermissionPolicy<Dependencies>>
type PolicyHost<Options extends EffectFoundationOptions> = CallbackHost<Options['writeAudit']> &
	QueryPolicyHost<Options & { observability: EffectFoundation<Options>['observability'] }>
/* oxlint-enable anti-slop/no-unknown-returns */

/** Keep registry indexing inside a named, constrained declaration boundary. */
type CrudExecutor<
	Host,
	Operations extends Readonly<Record<string, { input: ContractSchema; result: ContractSchema }>>,
	Callbacks,
	Guard,
> = {
	exec<Key extends Extract<keyof Operations, string>>(
		operation: Key,
		input: EffectOperationArgument<Operations[Key]>,
		host: Host,
	): Effect.Effect<
		EffectOperationResult<Operations[Key]>,
		| EffectOperationError<Operations[Key]>
		| CallbackError<Callbacks>
		| UnwrappedDefaultError<Operations[Key], Guard>,
		| EffectOperationRequirements<Operations[Key]>
		| CallbackRequirements<Callbacks>
		| UnwrappedDefaultRequirements<Operations[Key], Guard>
	>
}

export type EffectCrudConfig<
	Options extends EffectFoundationOptions,
	Host,
	ContextReturned,
	Table extends EffectCrudTable,
	Actor,
	Enrich,
	Insert,
	Patch,
	Get,
	List,
	Project,
	Policy,
	CreateGuard,
	UpdateGuard,
	ArchiveGuard,
	GetGuard,
	ListGuard,
	CreateOverride,
	UpdateOverride,
	ArchiveOverride,
	CheckId = never,
> = {
	foundation: EffectFoundation<Options>
	table: Table
	context: (host: Host) => ContextReturned
	aggregateType: string
	classification?: string
	/** Trusted table-membership check, not an existence lookup or a string-brand parser. */
	checkId?: (context: EffectValue<ContextReturned>, id: string) => CheckId
	actor: (context: EffectValue<ContextReturned>) => Actor
	enrich?: (context: EffectValue<ContextReturned>, input: Input<Table>) => Enrich
	repository?: EffectCrudRepository<EffectValue<ContextReturned>, Table, Insert, Patch>
	policy?: {
		guard?: (context: EffectValue<ContextReturned>) => Policy
		permissions?: Partial<Record<'create' | 'update' | 'archive' | 'get' | 'list', string>>
	}
	guards?: {
		create?: (context: EffectValue<ContextReturned>, input: Input<Table>) => CreateGuard
		update?: (context: EffectValue<ContextReturned>, input: Update<Table>) => UpdateGuard
		archive?: (context: EffectValue<ContextReturned>, input: IdInput<Table>) => ArchiveGuard
		get?: (context: EffectValue<ContextReturned>, input: IdInput<Table>) => GetGuard
		list?: (context: EffectValue<ContextReturned>, input: EffectCrudPagination) => ListGuard
	}
	overrides?: {
		create?: (input: Input<Table>, context: EffectValue<ContextReturned>) => CreateOverride
		update?: (input: Update<Table>, context: EffectValue<ContextReturned>) => UpdateOverride
		archive?: (input: IdInput<Table>, context: EffectValue<ContextReturned>) => ArchiveOverride
	}
	read: {
		/** Maximum initial page target; reactive ranges may return more rows. */
		maxPageSize: number
		/**
		 * Server-owned indexed pagination row budget; defaults to maxPageSize. Search ignores it.
		 * Native reactive ranges may exceed this budget; consumers must honor split metadata.
		 */
		maximumRowsRead?: number
		/** Return raw, undecoded public-schema input; the query result lifecycle decodes it once. */
		project: (row: Storage<Table>) => Project
		get: (context: EffectValue<ContextReturned>, id: Id<Table>) => Get
		/** Trusted adapters forward the supplied read budget to supported native pagination. */
		list: (context: EffectValue<ContextReturned>, input: EffectCrudPagination) => List
	}
} & (EffectValue<ContextReturned> extends EffectCrudContext<Table>
	? unknown
	: { repository: EffectCrudRepository<EffectValue<ContextReturned>, Table, Insert, Patch> }) &
	(EffectValue<ContextReturned> extends IdContext<Table>
		? unknown
		: { checkId: (context: EffectValue<ContextReturned>, id: string) => CheckId }) &
	StorageOverrides<Table>

/** Generate operations through the Foundation's bound helpers; no runner or policy lives here. */
export function createEffectCrud<
	const Options extends EffectFoundationOptions,
	Host extends PolicyHost<Options>,
	ContextReturned,
	const Table extends EffectCrudTable,
	Actor extends Supported<string>,
	Enrich extends Supported<Partial<Storage<Table>>> = never,
	Insert extends Supported<Id<Table>> = never,
	Patch extends Supported<void> = never,
	Get extends Supported<Storage<Table> | null> = never,
	List extends Supported<EffectCrudPage<Storage<Table>>> = never,
	Project extends Supported<z.input<Table['publicDto']>> = never,
	Policy extends Supported<void> = never,
	CreateGuard extends Supported<void> = never,
	UpdateGuard extends Supported<void> = never,
	ArchiveGuard extends Supported<void> = never,
	GetGuard extends Supported<void> = never,
	ListGuard extends Supported<void> = never,
	CreateOverride extends Supported<{ id: Id<Table> }> = never,
	UpdateOverride extends Supported<{ ok: true }> = never,
	ArchiveOverride extends Supported<{ ok: true }> = never,
	CheckId extends Supported<boolean> = never,
	const Configuration extends object = object,
>(
	config: Configuration &
		ProtectedOverrides<Configuration> &
		EffectCrudConfig<
			Options,
			Host,
			ContextReturned,
			Table,
			Actor,
			Enrich,
			Insert,
			Patch,
			Get,
			List,
			Project,
			Policy,
			CreateGuard,
			UpdateGuard,
			ArchiveGuard,
			GetGuard,
			ListGuard,
			CreateOverride,
			UpdateOverride,
			ArchiveOverride,
			CheckId
		>,
) {
	const { table } = config
	if ('tenant' in table.storage.shape && !config.enrich) {
		return defaultErrors.throw({
			code: 'CRUD_ENRICH_REQUIRED',
			message: `Table "${table.tableName}" requires an enrich callback`,
		})
	}
	if (!Number.isSafeInteger(config.read.maxPageSize) || config.read.maxPageSize < 1)
		throw Error('CRUD maxPageSize must be a positive safe integer')
	const maximumRowsRead = config.read.maximumRowsRead ?? config.read.maxPageSize
	if (!Number.isSafeInteger(maximumRowsRead) || maximumRowsRead < 1)
		throw Error('CRUD maximumRowsRead must be a positive safe integer')
	const name: Table['tableName'] = table.tableName
	const id = zid(name)
	const commandInput: StandardSchema<z.input<Table['commandInput']>, Input<Table>> &
		LegacyParser<Input<Table>> = crudSchema<Table['commandInput']>(table.commandInput)
	const updateInput: StandardSchema<z.input<Table['tools']['update']>, Update<Table>> &
		LegacyParser<Update<Table>> = crudSchema<Table['tools']['update']>(table.tools.update)
	const idInput: StandardSchema<z.input<Table['tools']['id']>, IdInput<Table>> &
		LegacyParser<IdInput<Table>> = crudSchema<Table['tools']['id']>(table.tools.id)
	const publicDto: Table['publicDto'] = table.publicDto
	const createResult: StandardSchema<{ id: string }, { id: Id<Table> }> &
		LegacyParser<{ id: Id<Table> }> = crudSchema(z.object({ id }).strict())
	const okResult = z.object({ ok: z.literal(true) }).strict()
	const pagination = z
		.object({
			numItems: z.number().int().min(1).max(config.read.maxPageSize),
			cursor: z.string().nullable(),
			endCursor: z.string().nullable().optional(),
			id: z.number().optional(),
			maximumRowsRead: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
			maximumBytesRead: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		})
		.strict()
	const pageResult = paginated(publicDto).result
	const classification = config.classification ?? 'business'
	const aggregate = (aggregateId: string) => ({ type: config.aggregateType, id: aggregateId })
	const createName = `${name}.create` as const
	const updateName = `${name}.update` as const
	const archiveName = `${name}.archive` as const
	const getName = `${name}.get` as const
	const listName = `${name}.list` as const
	type Domain = EffectValue<ContextReturned>
	function checkedId(context: Domain, value: string) {
		return normalizeAs<boolean, CheckId | boolean>(() => {
			if (config.checkId) return config.checkId(context, value)
			// SAFETY: without an explicit checker, configuration requires this normalizing reader.
			const secured = context as Domain & IdContext<Table>
			return secured.db.normalizeId(table.tableName, value) !== null
		}).pipe(
			Effect.map((valid) => {
				if (valid !== true)
					return defaultErrors.throw({
						code: 'CRUD_INVALID_ID',
						message: `Invalid ID for table "${table.tableName}"`,
					})
				// SAFETY: the trusted runtime table-membership boundary accepted this ID.
				return value as Id<Table>
			}),
		)
	}
	function insert(context: Domain, values: Storage<Table>) {
		if (config.repository) return normalizeEffect(() => config.repository!.insert(context, values))
		// SAFETY: without an explicit repository, EffectCrudConfig requires this secured writer context.
		const secured = context as Domain & EffectCrudContext<Table>
		return normalizeEffect(() => secured.db.insert(table.tableName, values))
	}
	function patch(context: Domain, documentId: Id<Table>, values: Partial<Storage<Table>>) {
		if (config.repository)
			return normalizeEffect(() => config.repository!.patch(context, documentId, values))
		// SAFETY: without an explicit repository, EffectCrudConfig requires this secured writer context.
		const secured = context as Domain & EffectCrudContext<Table>
		return normalizeEffect(() => secured.db.patch(documentId, values))
	}
	const defaultCreate = (input: Input<Table>, context: Domain) =>
		Effect.gen(function* () {
			const enrichment = yield* normalizeAs<
				Partial<Storage<Table>> | undefined,
				Enrich | undefined
			>(() => config.enrich?.(context, input))
			const values = Object.fromEntries(
				Object.entries({ ...input, ...enrichment }).filter(([, value]) => value !== undefined),
			)
			// SAFETY: StorageOverrides permits this default only for storage-compatible decoded fields; trusted enrichment wins and undefined fields are omitted.
			const stored = values as Storage<Table>
			return { id: yield* insert(context, stored) }
		})
	const create = chooseHandler<
		Input<Table>,
		Domain,
		CreateOverride,
		ReturnType<typeof defaultCreate>,
		RequiredOverride<Configuration, 'create'>
	>(config.overrides?.create, defaultCreate)
	// SAFETY: StorageOverrides permits this default only for storage-compatible decoded update fields.
	const defaultUpdate = (input: Update<Table>, context: Domain) =>
		patch(context, input.id as Id<Table>, input.data as Partial<Storage<Table>>).pipe(
			Effect.as({ ok: true as const }),
		)
	const chosenUpdate = chooseHandler<
		Update<Table>,
		Domain,
		UpdateOverride,
		ReturnType<typeof defaultUpdate>,
		RequiredOverride<Configuration, 'update'>
	>(config.overrides?.update, defaultUpdate)
	const update = (input: Update<Table>, context: Domain) =>
		checkedId(context, input.id).pipe(
			Effect.flatMap(() => normalizeEffect(() => chosenUpdate(input, context))),
		)
	// SAFETY: the checked handler below proves table membership; archive writes only its server timestamp.
	const defaultArchive = (input: IdInput<Table>, context: Domain) =>
		patch(context, input.id as Id<Table>, archivePatch<Table>(Date.now())).pipe(
			Effect.as({ ok: true as const }),
		)
	const chosenArchive = chooseHandler<
		IdInput<Table>,
		Domain,
		ArchiveOverride,
		ReturnType<typeof defaultArchive>,
		RequiredOverride<Configuration, 'archive'>
	>(config.overrides?.archive, defaultArchive)
	const archive = (input: IdInput<Table>, context: Domain) =>
		checkedId(context, input.id).pipe(
			Effect.flatMap(() => normalizeEffect(() => chosenArchive(input, context))),
		)
	const define = effectOperationFactory<
		Domain,
		Record<never, never>,
		CallbackError<Policy>,
		CallbackRequirements<Policy>
	>()
	const createAudit = ({ result }: { result: { id: Id<Table> } }, context: Domain) =>
		normalizeAs<string, Actor>(() => config.actor(context)).pipe(
			Effect.map((actorId) => ({
				operation: createName,
				actorId,
				aggregate: aggregate(result.id),
			})),
		)
	const updateAudit = ({ command: input }: { command: Update<Table> }, context: Domain) =>
		normalizeAs<string, Actor>(() => config.actor(context)).pipe(
			Effect.map((actorId) => ({ operation: updateName, actorId, aggregate: aggregate(input.id) })),
		)
	const archiveAudit = ({ command: input }: { command: IdInput<Table> }, context: Domain) =>
		normalizeAs<string, Actor>(() => config.actor(context)).pipe(
			Effect.map((actorId) => ({
				operation: archiveName,
				actorId,
				aggregate: aggregate(input.id),
			})),
		)
	const operations = Object.assign(
		{},
		named(
			createName,
			define.command<
				typeof commandInput,
				typeof createResult,
				ReturnType<typeof create>,
				CreateGuard,
				never,
				readonly string[],
				ReturnType<typeof createAudit>
			>({
				input: commandInput,
				result: createResult,
				classification,
				aggregates: [config.aggregateType],
				permission: config.policy?.permissions?.create,
				guard: config.guards?.create,
				handler: create,
				audit: createAudit,
			}),
		),
		named(
			updateName,
			define.command<
				typeof updateInput,
				typeof okResult,
				ReturnType<typeof update>,
				UpdateGuard,
				never,
				readonly string[],
				ReturnType<typeof updateAudit>
			>({
				input: updateInput,
				result: okResult,
				classification,
				aggregates: [config.aggregateType],
				permission: config.policy?.permissions?.update,
				guard: config.guards?.update,
				handler: update,
				audit: updateAudit,
			}),
		),
		named(
			archiveName,
			define.command<
				typeof idInput,
				typeof okResult,
				ReturnType<typeof archive>,
				ArchiveGuard,
				never,
				readonly string[],
				ReturnType<typeof archiveAudit>
			>({
				input: idInput,
				result: okResult,
				classification,
				aggregates: [config.aggregateType],
				permission: config.policy?.permissions?.archive,
				guard: config.guards?.archive,
				handler: archive,
				audit: archiveAudit,
			}),
		),
	)
	type Resolve = (host: Host) => ContextReturned
	type Dependencies = Options & { observability: Observability }
	const commandConfiguration = {
		context: config.context,
		defaults: { guard: config.policy?.guard },
		operations: () => operations,
	}
	// SAFETY: each operation was checked above; Host is constrained to both bound policy hosts. Generic mapped keys need the paired registry proof restored.
	const commands: CrudExecutor<Host, typeof operations, Resolve | Options[keyof Options], Policy> =
		config.foundation.Command<Resolve, typeof operations, Policy>(
			commandConfiguration as Parameters<
				typeof config.foundation.Command<Resolve, typeof operations, Policy>
			>[0],
		)
	const getResult: StandardSchema<
		z.input<Table['publicDto']> | null,
		z.output<Table['publicDto']> | null
	> &
		LegacyParser<z.output<Table['publicDto']> | null> = crudSchema(publicDto.nullable())
	const get = (input: IdInput<Table>, context: Domain) =>
		checkedId(context, input.id).pipe(
			Effect.flatMap((documentId) =>
				normalizeAs<Storage<Table> | null, Get>(() => config.read.get(context, documentId)),
			),
			Effect.flatMap((row) =>
				row === null
					? Effect.succeed(null)
					: normalizeAs<z.input<Table['publicDto']>, Project>(() => config.read.project(row)),
			),
		)
	const list = (input: EffectCrudPagination, context: Domain) =>
		normalizeAs<EffectCrudPage<Storage<Table>>, List>(() =>
			// Trusted adapters forward this budget to indexed db.paginate; native search does not enforce it.
			config.read.list(context, {
				...input,
				maximumRowsRead: Math.min(input.maximumRowsRead ?? maximumRowsRead, maximumRowsRead),
			}),
		).pipe(
			Effect.flatMap((page) =>
				Effect.forEach(page.page, (row) =>
					normalizeAs<z.input<Table['publicDto']>, Project>(() => config.read.project(row)),
				).pipe(Effect.map((rows) => ({ ...page, page: rows }))),
			),
		)
	const queryOperations = Object.assign(
		{},
		named(
			getName,
			define.query<typeof idInput, typeof getResult, ReturnType<typeof get>, GetGuard>({
				input: idInput,
				result: getResult,
				permission: config.policy?.permissions?.get,
				guard: config.guards?.get,
				handler: get,
			}),
		),
		named(
			listName,
			define.query<typeof pagination, typeof pageResult, ReturnType<typeof list>, ListGuard>({
				input: pagination,
				result: pageResult,
				permission: config.policy?.permissions?.list,
				guard: config.guards?.list,
				handler: list,
			}),
		),
	)
	const queryConfiguration = {
		context: config.context,
		defaults: { guard: config.policy?.guard },
		// SAFETY: the two query helpers checked these exact callbacks and schemas before literal-key assembly.
		operations: () => queryOperations,
	}
	// SAFETY: checked query helpers produced the registry above; explicit instantiation keeps mapped operation keys paired.
	const queries: CrudExecutor<
		Host,
		typeof queryOperations,
		ContextReturned | CallbackReturned<PermissionPolicy<Dependencies>>,
		Policy
	> = config.foundation.Query<Host, ContextReturned, typeof queryOperations, Policy>(
		queryConfiguration as Parameters<
			typeof config.foundation.Query<Host, ContextReturned, typeof queryOperations, Policy>
		>[0],
	)
	return { commands, queries, operations, queryOperations }
}

type NamedOperation<Name extends string, Definition> = { [Key in Name]: Definition }
function named<const Name extends string, Definition>(name: Name, definition: Definition) {
	// SAFETY: the single computed property pairs this literal operation name with its checked definition.
	return { [name]: definition } as NamedOperation<Name, Definition>
}
type ProtectedOverrides<Configuration> = 'overrides' extends keyof Configuration
	? {
			overrides?: {
				[
					Key in Exclude<
						keyof NonNullable<Configuration['overrides']>,
						'create' | 'update' | 'archive'
					>
				]: never
			}
		}
	: unknown
type RequiredOverride<Configuration, Key extends string> = Configuration extends {
	overrides: { [K in Key]: Function }
}
	? true
	: false
type Chosen<Override, Default, Required extends boolean> = Required extends true
	? Override
	: [Override] extends [never]
		? Default
		: Override | Default
function chooseHandler<Input, Context, Override, Default, Required extends boolean>(
	override: ((input: Input, context: Context) => Override) | undefined,
	fallback: (input: Input, context: Context) => Default,
): (input: Input, context: Context) => Chosen<Override, Default, Required> {
	// SAFETY: never is the absent override default; a declared override replaces only this handler.
	return (override ?? fallback) as (
		input: Input,
		context: Context,
	) => Chosen<Override, Default, Required>
}
function normalizeAs<Value, Returned extends Supported<Value>>(invoke: () => Returned) {
	// SAFETY: Returned is constrained to this success contract; normalization retains its exact error/service channels.
	return normalizeEffect(invoke) as Effect.Effect<
		Value,
		CallbackError<Returned>,
		CallbackRequirements<Returned>
	>
}
function crudSchema<Schema extends z.ZodType>(
	schema: Schema,
): StandardSchema<z.input<Schema>, z.output<Schema>> & LegacyParser<z.output<Schema>> {
	return {
		'~standard': schema['~standard'],
		parse: (value) => schema.parse(value),
		parseAsync: (value) => schema.parseAsync(value),
	}
}

function archivePatch<Table extends EffectCrudTable>(archivedAt: number): Partial<Storage<Table>> {
	// SAFETY: all kit table boundaries include the server-owned archivedAt timestamp.
	return Object.fromEntries([['archivedAt', archivedAt]]) as Partial<Storage<Table>>
}
