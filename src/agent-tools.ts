import { k, type KObject, type KType } from './k'
import { convexPaginationOptions } from './querying/filters'

/**
 * A framework-agnostic tool record: `args` is a `k` schema, which implements Standard Schema v1
 * (`args['~standard']`) and parses with `args.parse`. For a JSON Schema of the input (ids are strings,
 * `.describe()` texts carry through) call `toJsonSchema(record.args)` from `cvx-kit/json-schema`; for a
 * framework that only takes Zod, `toZod(record.args)` from `cvx-kit/zod`. The kit imports no agent
 * framework.
 */
export type AgentToolRecord<Result = unknown, Context = never, Input = never> = {
	name: string
	description: string
	args: KType
	handler: (ctx: Context, input: Input) => Promise<Result>
}

type ToolTable = {
	readonly tableName: string
	readonly tools: {
		readonly insert: KType
		readonly update: KType
		readonly id: KType
	}
}

/** The `list` tool input: Convex's pagination options under `paginationOpts`. */
export type AgentListArgs = KObject<{
	readonly paginationOpts: ReturnType<typeof convexPaginationOptions>
}>

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

/**
 * Emits agent tool definitions from the existing table tool masks: args are
 * the masks (`k` schemas; ids are strings in their JSON Schema),
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
	const masks: Record<keyof AgentToolHandlers, () => KType> = {
		create: () => table.tools.insert,
		update: () => table.tools.update,
		archive: () => table.tools.id,
		get: () => table.tools.id,
		list: listArgsSchema,
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
			args: masks[verb](),
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
					? AgentListArgs
					: Table['tools']['id']
		handler: NonNullable<Handlers[Verb]>
	}
}>
export {
	selectOperation,
	bindOperationExecutor,
	createOperationTools,
	operationToolDialect,
	type SelectedOperation,
	type OperationExecutor,
	type OperationPublicResult,
	type OperationToolJsonSchema,
	type OperationToolConverter,
	type OperationToolDefinition,
	type OperationToolOutcome,
	type OperationTool,
} from './modules/contracts/exposure'

let listArgs: AgentListArgs | undefined

/** Built on the first `list` tool, so importing this module builds nothing. */
function listArgsSchema(): AgentListArgs {
	return (listArgs ??= k.strictObject({ paginationOpts: convexPaginationOptions() }))
}
