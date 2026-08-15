import { convexToZod } from 'convex-helpers/server/zod4'
import { paginationOptsValidator } from 'convex/server'
import { z } from 'zod'

/**
 * A framework-agnostic tool record: directly spreadable into
 * @convex-dev/agent's createTool ({ description, args, handler }) and
 * adaptable to ai-sdk tool(). The kit imports neither framework — checked
 * against registry snapshots on 2026-08-14; re-verify at install time.
 */
export type AgentToolRecord = {
	name: string
	description: string
	args: z.ZodType
	handler: (ctx: never, input: never) => Promise<unknown>
}

type ToolTable = {
	tableName: string
	tools: {
		insert: z.ZodType
		update: z.ZodType
		id: z.ZodType
	}
}

type ToolHandler = (ctx: never, input: never) => Promise<unknown>

export type AgentToolHandlers = {
	/** Mutations: route through command executors — agents get audited commands. */
	create?: ToolHandler
	update?: ToolHandler
	archive?: ToolHandler
	/** Reads: caller-supplied query handlers (reads do not route through commands). */
	get?: ToolHandler
	list?: ToolHandler
}

const listArgs = z
	.object({ paginationOpts: convexToZod(paginationOptsValidator) })
	.strict()

/**
 * Emits agent tool definitions from the existing table tool masks: args are
 * the masks (jsonSafeZid keeps ids primitive in generated JSON schemas),
 * names are `<tableName>_<verb>`, and only the kinds you supply handlers for
 * are emitted. Wire mutation handlers to createCrudCommands executors (or
 * your own) so every agent action is an audited command.
 */
export function createAgentTools(
	table: ToolTable,
	handlers: AgentToolHandlers,
	options?: { descriptions?: Partial<Record<keyof AgentToolHandlers, string>> },
): Record<string, AgentToolRecord> {
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
	for (const verb of Object.keys(masks) as (keyof AgentToolHandlers)[]) {
		const handler = handlers[verb]
		if (!handler) continue
		tools[`${name}_${verb}`] = {
			name: `${name}_${verb}`,
			description: options?.descriptions?.[verb] ?? defaults[verb],
			args: masks[verb],
			handler,
		}
	}
	return tools
}
