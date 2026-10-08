import { Context, Effect } from 'effect'
import { z } from 'zod'
import { createEffectFoundation } from '../src/effect'
import { createEffectCrud, type EffectCrudPagination } from '../src/modules/effect/crud'
import { paginated, tenantTable, zodTable } from '../src/zod-table'
import type { GenericId } from 'convex/values'
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
class Repository extends Context.Service<Repository, { id: GenericId<'notes'> }>()(
	'CrudRepository',
) {}
class Audit extends Context.Service<Audit, { append: () => void }>()('CrudAudit') {}
class CreateError {
	readonly _tag = 'CreateError'
}
class PatchError {
	readonly _tag = 'PatchError'
}
class EnrichError {
	readonly _tag = 'EnrichError'
}
class GuardError {
	readonly _tag = 'GuardError'
}
class GetError {
	readonly _tag = 'GetError'
}
class ArchiveError {
	readonly _tag = 'ArchiveError'
}
type Host = { actor: string; tenant: string }
const table = tenantTable('notes', () => ({ text: z.string(), secret: z.string() }), {
	commandFields: ['text'],
	publicFields: ['text'],
})
const foundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: (_host: Host) =>
		Effect.gen(function* () {
			;(yield* Audit).append()
		}),
})
const configuration = {
	foundation,
	table,
	context: (host: Host) => host,
	aggregateType: 'note',
	checkId: (_ctx: Host, id: string) => id === 'id',
	actor: (ctx: Host) => ctx.actor,
	enrich: (ctx: Host) =>
		Effect.succeed({ tenant: ctx.tenant, secret: 'server' }).pipe(
			Effect.andThen(Effect.fail(new EnrichError())),
		),
	repository: {
		insert: (_ctx: Host, _values: z.input<typeof table.storage>) =>
			Effect.gen(function* () {
				yield* Repository
				return yield* Effect.fail(new CreateError())
			}),
		patch: (_ctx: Host, _id: GenericId<'notes'>, _values: Partial<z.input<typeof table.storage>>) =>
			Effect.fail(new PatchError()),
	},
	guards: {
		create: (_ctx: Host, input: { text: string }) => {
			void input.text
			return Effect.fail(new GuardError())
		},
	},
	read: {
		maxPageSize: 10,
		project: (row: z.input<typeof table.storage>) => ({ text: row.text }),
		get: (_ctx: Host, _id: GenericId<'notes'>) => Effect.fail(new GetError()),
		list: (_ctx: Host, _input: { numItems: number; cursor: string | null }) =>
			Promise.resolve({ page: [], isDone: true, continueCursor: '' }),
	},
}
const crud = createEffectCrud(configuration)
type CommandKeys = Assert<
	Equal<keyof typeof crud.operations, 'notes.create' | 'notes.update' | 'notes.archive'>
>
type QueryKeys = Assert<Equal<keyof typeof crud.queryOperations, 'notes.get' | 'notes.list'>>
type CommandExecutorKeys = Assert<
	Equal<Parameters<typeof crud.commands.exec>[0], keyof typeof crud.operations>
>
type QueryExecutorKeys = Assert<
	Equal<Parameters<typeof crud.queries.exec>[0], keyof typeof crud.queryOperations>
>
const keyAssertions: [CommandKeys, QueryKeys, CommandExecutorKeys, QueryExecutorKeys] = [
	true,
	true,
	true,
	true,
]
void keyAssertions
const created = crud.commands.exec(
	'notes.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
const updated = crud.commands.exec(
	'notes.update',
	{ id: 'id', data: {} },
	{ actor: 'actor', tenant: 'tenant' },
)
const got = crud.queries.exec('notes.get', { id: 'id' }, { actor: 'actor', tenant: 'tenant' })
type CreateSuccess = Assert<Equal<Effect.Success<typeof created>, { id: GenericId<'notes'> }>>
type CreateErrors = Assert<
	Equal<Effect.Error<typeof created>, CreateError | EnrichError | GuardError>
>
type CreateServices = Assert<Equal<Effect.Services<typeof created>, Repository | Audit>>
type UpdateErrors = Assert<Equal<Effect.Error<typeof updated>, PatchError>>
type UpdateServices = Assert<Equal<Effect.Services<typeof updated>, Audit>>
type GetSuccess = Assert<Equal<Effect.Success<typeof got>, { text: string } | null>>
type GetErrors = Assert<Equal<Effect.Error<typeof got>, GetError>>
type GetServices = Assert<Equal<Effect.Services<typeof got>, never>>
const assertions: [
	CreateSuccess,
	CreateErrors,
	CreateServices,
	UpdateErrors,
	UpdateServices,
	GetSuccess,
	GetErrors,
	GetServices,
] = [true, true, true, true, true, true, true, true]
void assertions
crud.commands.exec(
	'notes.create',
	// @ts-expect-error actor is not a caller command field
	{ text: 'raw', actor: 'forged' },
	{ actor: 'actor', tenant: 'tenant' },
)
crud.commands.exec(
	'notes.update',
	// @ts-expect-error tenant is not accepted by the command mask
	{ id: 'id', data: { tenant: 'forged' } },
	{ actor: 'actor', tenant: 'tenant' },
)
// @ts-expect-error operation keys preserve the literal table name
crud.commands.exec('other.create', { text: 'raw' }, { actor: 'actor', tenant: 'tenant' })
// @ts-expect-error no unbounded list call
crud.queries.exec('notes.list', {}, { actor: 'actor', tenant: 'tenant' })
// @ts-expect-error repository services cannot be omitted
Effect.runPromise(created)
const overridden = createEffectCrud({
	...configuration,
	overrides: {
		archive: (_input, ctx) => {
			void ctx.tenant
			return Effect.fail(new ArchiveError())
		},
	},
})
const archived = overridden.commands.exec(
	'notes.archive',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
type ArchiveErrors = Assert<Equal<Effect.Error<typeof archived>, ArchiveError>>
const archiveAssertion: ArchiveErrors = true
void archiveAssertion
createEffectCrud({
	...configuration,
	overrides: {
		// @ts-expect-error authority/policy/audit are not operation override fields
		writeAudit: () => undefined,
	},
})
createEffectCrud({
	...configuration,
	overrides: {
		// @ts-expect-error contracts cannot be replaced via operation overrides
		archive: { input: z.string(), handler: () => ({ ok: true }) },
	},
})

class Projection extends Context.Service<Projection, { text: string }>()('CrudProjection') {}
class ProjectionError {
	readonly _tag = 'ProjectionError'
}
class SharedPolicy extends Context.Service<SharedPolicy, { allowed: boolean }>()('CrudPolicy') {}
class SharedError {
	readonly _tag = 'SharedError'
}
const effectRead = createEffectCrud({
	...configuration,
	policy: {
		guard: (_context: Host) =>
			Effect.gen(function* () {
				if (!(yield* SharedPolicy).allowed) return yield* Effect.fail(new SharedError())
			}),
	},
	read: {
		...configuration.read,
		project: (_row) =>
			Effect.gen(function* () {
				yield* Projection
				return yield* Effect.fail(new ProjectionError())
			}),
	},
})
const projected = effectRead.queries.exec(
	'notes.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
type ProjectionErrors = Assert<
	Equal<Effect.Error<typeof projected>, GetError | ProjectionError | SharedError>
>
type ProjectionServices = Assert<
	Equal<Effect.Services<typeof projected>, Projection | SharedPolicy>
>
const projectionAssertions: [ProjectionErrors, ProjectionServices] = [true, true]
void projectionAssertions
const optionalOverride = createEffectCrud({
	...configuration,
	overrides: {
		archive: Math.random() > 0.5 ? () => Effect.fail(new ArchiveError()) : undefined,
	},
})
const optionalArchive = optionalOverride.commands.exec(
	'notes.archive',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
type OptionalOverrideErrors = Assert<
	Equal<Effect.Error<typeof optionalArchive>, ArchiveError | PatchError>
>
const optionalAssertion: OptionalOverrideErrors = true
void optionalAssertion

// A policy callback that does not use host context imposes no host requirement.
const noHostFoundation = createEffectFoundation({
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
	},
	writeAudit: () => undefined,
})
const noHost = createEffectCrud({ ...configuration, foundation: noHostFoundation })
void noHost.commands.exec('notes.create', { text: 'raw' }, { actor: 'actor', tenant: 'tenant' })

class ResolverService extends Context.Service<ResolverService, { ready: boolean }>()(
	'CrudResolver',
) {}
class ActorService extends Context.Service<ActorService, { actor: string }>()('CrudActor') {}
class ResolverError {
	readonly _tag = 'ResolverError'
}
class ActorError {
	readonly _tag = 'ActorError'
}
const serviceCallbacks = createEffectCrud({
	...configuration,
	context: (host: Host) =>
		Effect.gen(function* () {
			if (!(yield* ResolverService).ready) return yield* Effect.fail(new ResolverError())
			return host
		}),
	actor: (_context: Host) =>
		Effect.gen(function* () {
			const actor = (yield* ActorService).actor
			if (!actor) return yield* Effect.fail(new ActorError())
			return actor
		}),
})
const serviceCreate = serviceCallbacks.commands.exec(
	'notes.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
const serviceGet = serviceCallbacks.queries.exec(
	'notes.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
type ServiceCreateErrors = Assert<
	Equal<
		Effect.Error<typeof serviceCreate>,
		CreateError | EnrichError | GuardError | ResolverError | ActorError
	>
>
type ServiceCreateRequirements = Assert<
	Equal<Effect.Services<typeof serviceCreate>, Repository | Audit | ResolverService | ActorService>
>
type ServiceGetErrors = Assert<Equal<Effect.Error<typeof serviceGet>, GetError | ResolverError>>
type ServiceGetRequirements = Assert<Equal<Effect.Services<typeof serviceGet>, ResolverService>>
const serviceAssertions: [
	ServiceCreateErrors,
	ServiceCreateRequirements,
	ServiceGetErrors,
	ServiceGetRequirements,
] = [true, true, true, true]
void serviceAssertions

const promiseCallbacks = createEffectCrud({
	...configuration,
	enrich: async (ctx: Host) => ({ tenant: ctx.tenant, secret: 'trusted' }),
	actor: async (ctx: Host) => ctx.actor,
})
const promiseCreate = promiseCallbacks.commands.exec(
	'notes.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
type PromiseCallbackErrors = Assert<
	Equal<Effect.Error<typeof promiseCreate>, CreateError | GuardError>
>
const promiseAssertion: PromiseCallbackErrors = true
void promiseAssertion

class PermissionService extends Context.Service<PermissionService, { allowed: boolean }>()(
	'CrudPermission',
) {}
class PermissionError {
	readonly _tag = 'PermissionError'
}
class AuditError {
	readonly _tag = 'AuditError'
}
const hostPolicyCrud = createEffectCrud({
	...configuration,
	foundation: createEffectFoundation({
		observability: {
			enabled: false,
			classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }),
		},
		checkPermission: (_host: Host) =>
			Effect.gen(function* () {
				if (!(yield* PermissionService).allowed) return yield* Effect.fail(new PermissionError())
			}),
		writeAudit: (_host: Host) =>
			Effect.gen(function* () {
				yield* Audit
				return yield* Effect.fail(new AuditError())
			}),
	}),
})
const hostPolicyCreate = hostPolicyCrud.commands.exec(
	'notes.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
const hostPolicyGet = hostPolicyCrud.queries.exec(
	'notes.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
type HostPolicyCreateErrors = Assert<
	Equal<
		Effect.Error<typeof hostPolicyCreate>,
		CreateError | EnrichError | GuardError | PermissionError | AuditError
	>
>
type HostPolicyCreateServices = Assert<
	Equal<Effect.Services<typeof hostPolicyCreate>, Repository | PermissionService | Audit>
>
type HostPolicyGetErrors = Assert<
	Equal<Effect.Error<typeof hostPolicyGet>, GetError | PermissionError>
>
type HostPolicyGetServices = Assert<Equal<Effect.Services<typeof hostPolicyGet>, PermissionService>>
const hostPolicyAssertions: [
	HostPolicyCreateErrors,
	HostPolicyCreateServices,
	HostPolicyGetErrors,
	HostPolicyGetServices,
] = [true, true, true, true]
void hostPolicyAssertions

// Decoded fields must fit storage INPUT, independently for create/update.
const transformedTable = zodTable(
	'lengths',
	() => ({ text: z.string().transform((value) => value.length) }),
	{
		commandFields: ['text'],
		publicFields: ['text'],
	},
)
const transformedConfiguration = {
	...configuration,
	table: transformedTable,
	guards: undefined,
	enrich: undefined,
	repository: {
		insert: (_ctx: Host, _values: z.input<typeof transformedTable.storage>) =>
			transformedTable.tools.id.parse({ id: 'id' }).id,
		patch: (
			_ctx: Host,
			_id: GenericId<'lengths'>,
			_values: Partial<z.input<typeof transformedTable.storage>>,
		) => undefined,
	},
	read: {
		maxPageSize: 2,
		project: (row: z.input<typeof transformedTable.storage>) => ({ text: row.text }),
		get: () => null,
		list: () => ({ page: [], isDone: true, continueCursor: '' }),
	},
}
// @ts-expect-error incompatible decoded storage fields require definite retained-contract overrides
createEffectCrud(transformedConfiguration)
createEffectCrud({
	...transformedConfiguration,
	// @ts-expect-error a create override does not make the incompatible default update safe
	overrides: { create: () => ({ id: transformedTable.tools.id.parse({ id: 'id' }).id }) },
})
createEffectCrud({
	...transformedConfiguration,
	// @ts-expect-error an update override does not make the incompatible default create safe
	overrides: { update: () => ({ ok: true as const }) },
})
const transformedHandlers = {
	create: (input: z.output<typeof transformedTable.commandInput>, ctx: Host) => ({
		id: transformedConfiguration.repository.insert(ctx, { text: String(input.text) }),
	}),
	update: (input: z.output<typeof transformedTable.tools.update>, ctx: Host) => {
		transformedConfiguration.repository.patch(
			ctx,
			input.id,
			input.data.text === undefined ? {} : { text: String(input.data.text) },
		)
		return { ok: true as const }
	},
}
createEffectCrud({ ...transformedConfiguration, overrides: transformedHandlers })
createEffectCrud({
	...transformedConfiguration,
	overrides: {
		...transformedHandlers,
		// @ts-expect-error optional create may fall back to an incompatible storage write
		create: Math.random() > 0.5 ? transformedHandlers.create : undefined,
	},
})
createEffectCrud({
	...transformedConfiguration,
	overrides: {
		...transformedHandlers,
		// @ts-expect-error optional update may fall back to an incompatible storage write
		update: Math.random() > 0.5 ? transformedHandlers.update : undefined,
	},
})

// Inline handlers must infer their decoded input and exact callback channels.
const inlineMapped = createEffectCrud({
	...transformedConfiguration,
	overrides: {
		create: (input, ctx) => ({
			id: transformedConfiguration.repository.insert(ctx, { text: String(input.text) }),
		}),
		update: (input, ctx) => {
			transformedConfiguration.repository.patch(
				ctx,
				input.id,
				input.data.text === undefined ? {} : { text: String(input.data.text) },
			)
			return { ok: true as const }
		},
	},
})
const inlineCreate = inlineMapped.commands.exec(
	'lengths.create',
	{ text: 'abc' },
	{ actor: 'actor', tenant: 'tenant' },
)
const inlineAssertions: [
	Assert<Equal<Effect.Error<typeof inlineCreate>, never>>,
	Assert<Equal<Effect.Services<typeof inlineCreate>, Audit>>,
] = [true, true]
void inlineAssertions

class IdCheck extends Context.Service<IdCheck, { valid: boolean }>()('CrudIdCheck') {}
class IdCheckError {
	readonly _tag = 'IdCheckError'
}
const checked = createEffectCrud({
	...configuration,
	checkId: (_ctx, _id) =>
		Effect.gen(function* () {
			if (!(yield* IdCheck).valid) return yield* Effect.fail(new IdCheckError())
			return true
		}),
})
const checkedGet = checked.queries.exec(
	'notes.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedUpdate = checked.commands.exec(
	'notes.update',
	{ id: 'id', data: {} },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedArchive = checked.commands.exec(
	'notes.archive',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedCreate = checked.commands.exec(
	'notes.create',
	{ text: 'abc' },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedList = checked.queries.exec(
	'notes.list',
	{ numItems: 1, cursor: null },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkerAssertions: [
	Assert<Equal<Effect.Error<typeof checkedGet>, GetError | IdCheckError>>,
	Assert<Equal<Effect.Services<typeof checkedGet>, IdCheck>>,
	Assert<Equal<Effect.Error<typeof checkedUpdate>, PatchError | IdCheckError>>,
	Assert<Equal<Effect.Services<typeof checkedUpdate>, Audit | IdCheck>>,
	Assert<Equal<Effect.Error<typeof checkedArchive>, PatchError | IdCheckError>>,
	Assert<Equal<Effect.Services<typeof checkedArchive>, Audit | IdCheck>>,
	Assert<Equal<Effect.Error<typeof checkedCreate>, Effect.Error<typeof created>>>,
	Assert<Equal<Effect.Services<typeof checkedCreate>, Effect.Services<typeof created>>>,
	Assert<Equal<Effect.Error<typeof checkedList>, never>>,
	Assert<Equal<Effect.Services<typeof checkedList>, never>>,
] = [true, true, true, true, true, true, true, true, true, true]
void checkerAssertions
const { checkId: removedCheck, ...noChecker } = configuration
void removedCheck
// @ts-expect-error a custom context without native normalization requires a definite trusted checker
createEffectCrud(noChecker)
// @ts-expect-error an optional checker cannot replace a missing native normalizer
createEffectCrud({ ...noChecker, checkId: Math.random() > 0.5 ? configuration.checkId : undefined })
const nativeConfiguration = {
	...noChecker,
	context: (h: Host) => ({
		...h,
		db: {
			normalizeId: (_table: 'notes', id: string) =>
				id === 'id' ? table.tools.id.parse({ id }).id : null,
		},
	}),
}
// Reader-only normalization plus an injected writer is sufficient.
createEffectCrud(nativeConfiguration)
const optionalChecked = createEffectCrud({
	...nativeConfiguration,
	checkId:
		Math.random() > 0.5
			? () =>
					Effect.gen(function* () {
						yield* IdCheck
						return yield* Effect.fail(new IdCheckError())
					})
			: undefined,
	overrides: {
		create: Math.random() > 0.5 ? () => Effect.fail(new ArchiveError()) : undefined,
		update: Math.random() > 0.5 ? () => Effect.fail(new ArchiveError()) : undefined,
		archive: () => Effect.succeed({ ok: true as const }),
	},
})
const optionalCheckedCreate = optionalChecked.commands.exec(
	'notes.create',
	{ text: 'abc' },
	{ actor: 'actor', tenant: 'tenant' },
)
const optionalCheckedUpdate = optionalChecked.commands.exec(
	'notes.update',
	{ id: 'id', data: {} },
	{ actor: 'actor', tenant: 'tenant' },
)
const optionalCheckedArchive = optionalChecked.commands.exec(
	'notes.archive',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
const optionalCheckedGet = optionalChecked.queries.exec(
	'notes.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
const optionalCheckedAssertions: [
	Assert<
		Equal<
			Effect.Error<typeof optionalCheckedCreate>,
			CreateError | EnrichError | GuardError | ArchiveError
		>
	>,
	Assert<Equal<Effect.Services<typeof optionalCheckedCreate>, Repository | Audit>>,
	Assert<
		Equal<Effect.Error<typeof optionalCheckedUpdate>, PatchError | ArchiveError | IdCheckError>
	>,
	Assert<Equal<Effect.Services<typeof optionalCheckedUpdate>, Audit | IdCheck>>,
	Assert<Equal<Effect.Error<typeof optionalCheckedArchive>, IdCheckError>>,
	Assert<Equal<Effect.Services<typeof optionalCheckedArchive>, Audit | IdCheck>>,
	Assert<Equal<Effect.Error<typeof optionalCheckedGet>, GetError | IdCheckError>>,
	Assert<Equal<Effect.Services<typeof optionalCheckedGet>, IdCheck>>,
] = [true, true, true, true, true, true, true, true]
void optionalCheckedAssertions

const effectMapped = createEffectCrud({
	...transformedConfiguration,
	repository: {
		insert: (_ctx: Host, _values: z.input<typeof transformedTable.storage>) =>
			Effect.gen(function* () {
				yield* Repository
				return yield* Effect.fail(new CreateError())
			}),
		patch: (
			_ctx: Host,
			_id: GenericId<'lengths'>,
			_values: Partial<z.input<typeof transformedTable.storage>>,
		) => Effect.fail(new PatchError()),
	},
	overrides: {
		create: (input) => {
			const decoded: number = input.text
			void decoded
			return Effect.fail(new ArchiveError())
		},
		update: (input) =>
			Effect.gen(function* () {
				const decoded: number | undefined = input.data.text
				void decoded
				yield* IdCheck
				return yield* Effect.fail(new IdCheckError())
			}),
	},
})
const effectMappedCreate = effectMapped.commands.exec(
	'lengths.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
const effectMappedUpdate = effectMapped.commands.exec(
	'lengths.update',
	{ id: 'id', data: { text: 'raw' } },
	{ actor: 'actor', tenant: 'tenant' },
)
const effectMappedGet = effectMapped.queries.exec(
	'lengths.get',
	{ id: 'id' },
	{ actor: 'actor', tenant: 'tenant' },
)
const effectMappedAssertions: [
	Assert<Equal<Effect.Error<typeof effectMappedCreate>, ArchiveError>>,
	Assert<Equal<Effect.Services<typeof effectMappedCreate>, Audit>>,
	Assert<Equal<Effect.Error<typeof effectMappedUpdate>, IdCheckError>>,
	Assert<Equal<Effect.Services<typeof effectMappedUpdate>, Audit | IdCheck>>,
	Assert<Equal<Effect.Success<typeof effectMappedGet>, { text: number } | null>>,
] = [true, true, true, true, true]
void effectMappedAssertions

const checkedMapped = createEffectCrud({
	...transformedConfiguration,
	checkId: () =>
		Effect.gen(function* () {
			yield* IdCheck
			return yield* Effect.fail(new IdCheckError())
		}),
	overrides: transformedHandlers,
})
const checkedMappedCreate = checkedMapped.commands.exec(
	'lengths.create',
	{ text: 'raw' },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedMappedUpdate = checkedMapped.commands.exec(
	'lengths.update',
	{ id: 'id', data: {} },
	{ actor: 'actor', tenant: 'tenant' },
)
const checkedMappedAssertions: [
	Assert<Equal<Effect.Error<typeof checkedMappedCreate>, never>>,
	Assert<Equal<Effect.Services<typeof checkedMappedCreate>, Audit>>,
	Assert<Equal<Effect.Error<typeof checkedMappedUpdate>, IdCheckError>>,
	Assert<Equal<Effect.Services<typeof checkedMappedUpdate>, Audit | IdCheck>>,
] = [true, true, true, true]
void checkedMappedAssertions

// Native helper options and inline server read configuration keep their inferred contracts.
class PaginationReader extends Context.Service<PaginationReader, { ready: boolean }>()(
	'CrudPaginationReader',
) {}
class PaginationReadError {
	readonly _tag = 'PaginationReadError'
}
const paginationCrud = createEffectCrud({
	...configuration,
	guards: {
		list: (_ctx, input) => {
			const options: EffectCrudPagination = input
			const endCursor: string | null | undefined = input.endCursor
			const id: number | undefined = input.id
			void [options, endCursor, id]
			return undefined
		},
	},
	read: {
		...configuration.read,
		maximumRowsRead: 30,
		list: (ctx, input) => {
			const actor: string = ctx.actor
			const options: EffectCrudPagination = input
			const rows: number | undefined = input.maximumRowsRead
			const bytes: number | undefined = input.maximumBytesRead
			void [actor, options, rows, bytes]
			return Effect.gen(function* () {
				yield* PaginationReader
				return yield* Effect.fail(new PaginationReadError())
			})
		},
	},
})
const publicPaginationOptions = paginated(table.publicDto).args.paginationOpts.parse({
	numItems: 2,
	cursor: null,
	id: 1,
	endCursor: 'split',
	maximumRowsRead: 20,
	maximumBytesRead: 1024,
})
const paginationList = paginationCrud.queries.exec('notes.list', publicPaginationOptions, {
	actor: 'actor',
	tenant: 'tenant',
})
paginationCrud.queries.exec(
	'notes.list',
	{
		numItems: 2,
		cursor: null,
		id: 1,
		endCursor: null,
		maximumRowsRead: 20,
		maximumBytesRead: 1024,
	},
	{ actor: 'actor', tenant: 'tenant' },
)
const paginationAssertions: [
	Assert<Equal<Effect.Error<typeof paginationList>, PaginationReadError>>,
	Assert<Equal<Effect.Services<typeof paginationList>, PaginationReader>>,
	Assert<
		Equal<
			Effect.Success<typeof paginationList>,
			{
				page: { text: string }[]
				isDone: boolean
				continueCursor: string
				splitCursor?: string | null
				pageStatus?: 'SplitRecommended' | 'SplitRequired' | null
			}
		>
	>,
] = [true, true, true]
void paginationAssertions
paginationCrud.queries.exec(
	'notes.list',
	{
		numItems: 2,
		cursor: null,
		// @ts-expect-error native end cursors are strings or null
		endCursor: 5,
	},
	{ actor: 'actor', tenant: 'tenant' },
)
paginationCrud.queries.exec(
	'notes.list',
	{
		numItems: 2,
		cursor: null,
		// @ts-expect-error unknown caller configuration remains excluded
		serverBudget: 500,
	},
	{ actor: 'actor', tenant: 'tenant' },
)
