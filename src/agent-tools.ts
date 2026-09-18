import { convexToZod } from 'convex-helpers/server/zod4'
import { paginationOptsValidator } from 'convex/server'
import { z } from 'zod'

/**
 * A framework-agnostic tool record: directly spreadable into
 * @convex-dev/agent's createTool ({ description, args, handler }) and
 * adaptable to ai-sdk tool(). The kit imports neither framework — checked
 * against registry snapshots on 2026-08-14; re-verify at install time.
 */
export type AgentToolRecord<Result = unknown, Context = never, Input = never> = {
	name: string
	description: string
	args: z.ZodType
	handler: (ctx: Context, input: Input) => Promise<Result>
}

type ToolTable = {
	tableName: string
	tools: {
		insert: z.ZodType
		update: z.ZodType
		id: z.ZodType
	}
}

type ToolHandler<Result> = (ctx: never, input: never) => Promise<Result>

export type AgentToolHandlers<Result = unknown> = {
	/** Mutations: route through command executors — agents get audited commands. */
	create?: ToolHandler<Result>
	update?: ToolHandler<Result>
	archive?: ToolHandler<Result>
	/** Reads: caller-supplied query handlers (reads do not route through commands). */
	get?: ToolHandler<Result>
	list?: ToolHandler<Result>
}

const listArgs = z.object({ paginationOpts: convexToZod(paginationOptsValidator) }).strict()

/**
 * Emits agent tool definitions from the existing table tool masks: args are
 * the masks (jsonSafeZid keeps ids primitive in generated JSON schemas),
 * names are `<tableName>_<verb>`, and only the kinds you supply handlers for
 * are emitted. Wire mutation handlers to createCrudCommands executors (or
 * your own) so every agent action is an audited command.
 */
export function createAgentTools<Table extends ToolTable, Handlers extends AgentToolHandlers>(
	table: Table,
	handlers: Handlers,
	options?: { descriptions?: Partial<Record<keyof AgentToolHandlers, string>> },
) {
	const name = table.tableName
	const masks: Record<keyof AgentToolHandlers, z.ZodType> = {
		create: table.tools.insert,
		update: table.tools.update,
		archive: table.tools.id,
		get: table.tools.id,
		list: listArgs,
	}
	const defaults: Record<keyof AgentToolHandlers, string> = {
		create: `Create a ${name} record`,
		update: `Update fields of an existing ${name} record`,
		archive: `Archive (soft-delete) a ${name} record`,
		get: `Fetch one ${name} record by id`,
		list: `List ${name} records, paginated`,
	}
	const tools: Record<string, AgentToolRecord> = {}
	for (const verb of ['create', 'update', 'archive', 'get', 'list'] as const) {
		const handler = handlers[verb]
		if (!handler) continue
		tools[`${name}_${verb}`] = {
			name: `${name}_${verb}`,
			description: options?.descriptions?.[verb] ?? defaults[verb],
			args: masks[verb],
			handler,
		}
	}
	// SAFETY: each emitted key combines this table name with a supplied verb; its handler and schema come from those same inputs.
	return tools as AgentTools<Table, Handlers>
}

export type AgentTools<Table extends ToolTable, Handlers extends AgentToolHandlers> = Partial<{
	[Verb in keyof Handlers & keyof AgentToolHandlers as `${Table['tableName']}_${Verb}`]: {
		name: string
		description: string
		args: Verb extends 'create'
			? Table['tools']['insert']
			: Verb extends 'update'
				? Table['tools']['update']
				: Verb extends 'list'
					? typeof listArgs
					: Table['tools']['id']
		handler: NonNullable<Handlers[Verb]>
	}
}>
