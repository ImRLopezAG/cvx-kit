import { zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'
import type {
	AnyCommandMiddleware,
	ApplicationCommand,
	AuditedRegistry,
	CommandConstructor,
} from './components/foundation/client'
import { defaultErrors, type ErrorFactory } from './errors'

/**
 * The zodTable surface the factory consumes — structural, so any zodTable /
 * tenantTable return satisfies it.
 */
type CrudTable = {
	tableName: string
	// biome-ignore format: structural zod surface
	commandInput: z.ZodObject<Record<string, z.ZodType>>
	storage: z.ZodObject<Record<string, z.ZodType>>
}

type CrudContext = {
	db: {
		insert: (table: never, value: never) => Promise<unknown>
		patch: (id: never, value: never) => Promise<unknown>
	}
}

type MaybePromise<Value> = Value | Promise<Value>

export type CrudConfig<Context extends CrudContext> = {
	/** The Foundation-bound Command class (destructured from the facade). */
	Command: CommandConstructor
	table: CrudTable
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
		command: Record<string, unknown>,
	) => Record<string, unknown> | Promise<Record<string, unknown>>
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
export type CrudCommands<Context extends CrudContext> = {
	commands: ApplicationCommand<Context, AuditedRegistry>
	operations: AuditedRegistry
	executeCreate: (
		context: Context,
		command: Record<string, unknown>,
	) => Promise<{ id: string }>
	executeUpdate: (
		context: Context,
		command: { id: string; data: Record<string, unknown> },
	) => Promise<{ ok: true }>
	executeArchive: (
		context: Context,
		command: { id: string },
	) => Promise<{ ok: true }>
}

export function createCrudCommands<Context extends CrudContext>(
	config: CrudConfig<Context>,
): CrudCommands<Context> {
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

	const id = zid(name)
	const createResult = z.object({ id }).strict()
	const okResult = z.object({ ok: z.literal(true) }).strict()
	const updateInput = z
		.object({ id, data: config.table.commandInput.partial().strict() })
		.strict()
	const archiveInput = z.object({ id }).strict()

	const operations = {
		[`${name}.create`]: {
			command: config.table.commandInput,
			result: createResult,
			classification,
			aggregates: [config.aggregateType],
			...(config.middleware ? { middleware: config.middleware } : {}),
			...(config.guards?.create ? { guard: config.guards.create } : {}),
			audit: (
				resolution: { command: unknown; result: { id: string } },
				context: Context,
			) => ({
				operation: `${name}.create`,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.result.id },
			}),
		},
		[`${name}.update`]: {
			command: updateInput,
			result: okResult,
			classification,
			aggregates: [config.aggregateType],
			...(config.middleware ? { middleware: config.middleware } : {}),
			...(config.guards?.update ? { guard: config.guards.update } : {}),
			audit: (
				resolution: { command: { id: string }; result: unknown },
				context: Context,
			) => ({
				operation: `${name}.update`,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.command.id },
			}),
		},
		[`${name}.archive`]: {
			command: archiveInput,
			result: okResult,
			classification,
			aggregates: [config.aggregateType],
			...(config.middleware ? { middleware: config.middleware } : {}),
			...(config.guards?.archive ? { guard: config.guards.archive } : {}),
			audit: (
				resolution: { command: { id: string }; result: unknown },
				context: Context,
			) => ({
				operation: `${name}.archive`,
				actorId: config.actor(context),
				aggregate: { type: config.aggregateType, id: resolution.command.id },
			}),
		},
	} as never

	const commands = new config.Command<Context, AuditedRegistry>(operations)

	const executeCreate = commands.exec({
		operation: `${name}.create` as never,
		handler: (async (context: Context, command: Record<string, unknown>) => {
			const enrichment = config.enrich
				? await config.enrich(context, command)
				: {}
			const inserted = await context.db.insert(
				name as never,
				{ ...command, ...enrichment } as never,
			)
			return { id: inserted }
		}) as never,
	})

	const executeUpdate = commands.exec({
		operation: `${name}.update` as never,
		handler: (async (
			context: Context,
			command: { id: string; data: Record<string, unknown> },
		) => {
			await context.db.patch(command.id as never, command.data as never)
			return { ok: true }
		}) as never,
	})

	const executeArchive = commands.exec({
		operation: `${name}.archive` as never,
		handler: (async (context: Context, command: { id: string }) => {
			await context.db.patch(
				command.id as never,
				{ archivedAt: Date.now() } as never,
			)
			return { ok: true }
		}) as never,
	})

	return {
		commands,
		operations: operations as AuditedRegistry,
		executeCreate,
		executeUpdate,
		executeArchive,
	} as unknown as CrudCommands<Context>
}
