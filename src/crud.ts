import { zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'
import type { Value } from 'convex/values'
import type { GenericDataModel, GenericMutationCtx } from 'convex/server'
import type {
	AnyCommandMiddleware,
	ApplicationCommand,
	AuditedOperation,
	CommandConstructor,
} from './components/foundation/client'
import { defaultErrors, type ErrorFactory } from './errors'

/**
 * The zodTable surface the factory consumes — structural, so any zodTable /
 * tenantTable return satisfies it.
 */
type CrudTable = {
	tableName: string
	commandInput: z.ZodObject<Record<string, z.ZodType<Value | undefined>>>
	storage: z.ZodObject<Record<string, z.ZodType<Value | undefined>>>
}

type CrudContext = { db: Pick<GenericMutationCtx<GenericDataModel>['db'], 'insert' | 'patch'> }

type MaybePromise<Value> = Value | Promise<Value>

export type CrudConfig<Context extends CrudContext, Table extends CrudTable = CrudTable> = {
	/** The Foundation-bound Command class (destructured from the facade). */
	Command: CommandConstructor
	table: Table
	/** Audit aggregate type; enforced by the aggregates allowlist. */
	aggregateType: string
	/** Observability/audit classification. Default 'business'. */
	classification?: string
	/** Derives the audited actor id from the ctx (usually ctx.actor.userId). */
	actor: (context: Context) => string
	/**
	 * Stamps server-owned fields onto creates (tenant, denormalized ids...).
	 * REQUIRED when the table is a tenantTable — forgetting it would insert
	 * untenanted rows; the factory fails fast at construction instead.
	 */
	enrich?: (
		context: Context,
		command: ReturnType<Table['commandInput']['parse']>,
	) => MaybePromise<Partial<z.input<Table['storage']>>>
	/** Per-operation preconditions; run before the handlers. */
	guards?: {
		create?: (context: Context, command: never) => MaybePromise<void>
		update?: (context: Context, command: never) => MaybePromise<void>
		archive?: (context: Context, command: never) => MaybePromise<void>
	}
	/** Per-operation middleware applied to all three generated operations. */
	middleware?: readonly AnyCommandMiddleware[]
	errors?: ErrorFactory
}

/**
 * Generates the standard create/update/archive operations from one zodTable
 * declaration, fully inside the audited command pipeline: strict command
 * inputs from `commandFields`, mandatory audit with the declared aggregate
 * type, soft delete only (archive sets `archivedAt` — no hard-delete
 * operation is generated, per kit doctrine).
 *
 * convex-helpers ships a same-named `crud` helper; it was deliberately not
 * used — it bypasses the command pipeline (no audits, no guards, and hard
 * deletes). See docs/crud.md.
 */
export type CrudCommands<
	Context extends CrudContext,
	Table extends CrudTable = CrudTable,
> = ReturnType<typeof createCrudCommands<Context, Table>>

export function createCrudCommands<
	Context extends CrudContext,
	Table extends CrudTable = CrudTable,
>(config: CrudConfig<Context, Table>) {
	const errors = config.errors ?? defaultErrors
	const name = config.table.tableName
	const classification = config.classification ?? 'business'
	const isTenantTable = 'tenant' in config.table.storage.shape
	if (isTenantTable && !config.enrich) {
		return errors.throw({
			code: 'CRUD_ENRICH_REQUIRED',
			message: `Table "${name}" is a tenantTable: createCrudCommands requires an enrich callback that stamps ctx.tenant`,
		})
	}

	const commandSchema: Table['commandInput'] = config.table.commandInput
	const id = zid(name)
	const createResult = z.object({ id }).strict()
	const okResult = z.object({ ok: z.literal(true) }).strict()
	const updateInput = z.object({ id, data: commandSchema.partial().strict() }).strict()
	const archiveInput = z.object({ id }).strict()

	const createName = `${name}.create` as const
	const updateName = `${name}.update` as const
	const archiveName = `${name}.archive` as const
	const operations = Object.assign(
		{},
		namedOperation(createName, {
			command: commandSchema,
			result: createResult,
			classification,
			aggregates: [config.aggregateType],
			middleware: config.middleware,
			guard: config.guards?.create,
			audit: (resolution: { result: z.output<typeof createResult> }, context: Context) => ({
				operation: createName,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.result.id },
			}),
		}),
		namedOperation(updateName, {
			command: updateInput,
			result: okResult,
			classification,
			aggregates: [config.aggregateType],
			middleware: config.middleware,
			guard: config.guards?.update,
			audit: (resolution: { command: z.output<typeof updateInput> }, context: Context) => ({
				operation: updateName,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.command.id },
			}),
		}),
		namedOperation(archiveName, {
			command: archiveInput,
			result: okResult,
			classification,
			aggregates: [config.aggregateType],
			middleware: config.middleware,
			guard: config.guards?.archive,
			audit: (resolution: { command: z.output<typeof archiveInput> }, context: Context) => ({
				operation: archiveName,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.command.id },
			}),
		}),
	)
	const commands: ApplicationCommand<Context, typeof operations> = new config.Command<
		Context,
		typeof operations
	>(operations)
	const executeCreate = commands.exec({
		operation: createName,
		handler: async (context, command) => {
			const enrichment = config.enrich ? await config.enrich(context, command) : {}
			const values: Record<string, Value> = {}
			for (const [field, value] of Object.entries({ ...command, ...enrichment })) {
				if (value !== undefined) values[field] = value
			}
			const inserted = await context.db.insert(name, values)
			return { id: inserted }
		},
	})
	const executeUpdate = commands.exec({
		operation: updateName,
		handler: async (context, command) => {
			await context.db.patch(command.id, command.data)
			return { ok: true }
		},
	})
	const executeArchive = commands.exec({
		operation: archiveName,
		handler: async (context, command) => {
			await context.db.patch(command.id, { archivedAt: Date.now() })
			return { ok: true }
		},
	})

	return {
		commands,
		operations,
		executeCreate,
		executeUpdate,
		executeArchive,
	}
}

function namedOperation<Name extends string, Definition extends AuditedOperation>(
	name: Name,
	definition: Definition,
) {
	// SAFETY: this object contains exactly the computed name and its corresponding definition.
	return { [name]: definition } as NamedOperation<Name, Definition>
}

type NamedOperation<Name extends string, Definition extends AuditedOperation> = {
	[Key in Name]: Definition
}
