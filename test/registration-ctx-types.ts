import {
	actionGeneric,
	defineSchema,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	mutationGeneric,
	queryGeneric,
	type DataModelFromSchemaDefinition,
	type GenericQueryCtx,
} from 'convex/server'
import type { KCustomCtx as RootKCustomCtx } from '../src/index'
import type { AuthBundle, Include } from '../src/auth'
import { createAuthFunctions } from '../src/auth'
import {
	k,
	type AnyKSchema,
	type KOptional,
	type KRecordKey,
	type KString,
	type KType,
} from '../src/k'
import type { KCursorSchema } from '../src/querying'
import { kCustomQuery, type KCustomCtx } from '../src/registration'
import { kTable } from '../src/table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const tasks = kTable('tasks', { title: k.string() })
const schema = defineSchema({ tasks: tasks.table })
type DataModel = DataModelFromSchemaDefinition<typeof schema>
const auth = createAuthFunctions<DataModel, 'viewer'>({
	query: queryGeneric,
	mutation: mutationGeneric,
	action: actionGeneric,
	internalQuery: internalQueryGeneric,
	internalMutation: internalMutationGeneric,
	internalAction: internalActionGeneric,
	getAuthUser: async () => ({ id: 'user' }),
	mapRole: () => 'viewer',
	adminRoles: [],
})
const authQuery = auth.authQuery
type AuthCtx = KCustomCtx<typeof authQuery>

let received: unknown
authQuery({
	args: { id: k.id('tasks') },
	handler: (ctx) => {
		received = ctx
		const same: AuthCtx = ctx
		void same
		return null
	},
})
void received

/** A helper typed against the builder's ctx, as the trial app's AuthCtx helpers were. */
async function titleOf(ctx: AuthCtx, id: k.infer<ReturnType<typeof k.id<'tasks'>>>) {
	const row = await ctx.db.get(id)
	return row?.title ?? ctx.user.id
}
void titleOf

const plain = kCustomQuery(queryGeneric, {
	args: {},
	input: async () => ({ ctx: { extra: 1 }, args: {} }),
})

const ctxAssertions: [
	Assert<
		Equal<
			AuthCtx,
			Omit<
				GenericQueryCtx<DataModel>,
				keyof (GenericQueryCtx<DataModel> & AuthBundle<'viewer'> & { include: Include })
			> &
				GenericQueryCtx<DataModel> &
				AuthBundle<'viewer'> & { include: Include }
		>
	>,
	Assert<Equal<RootKCustomCtx<typeof authQuery>, AuthCtx>>,
	Assert<Equal<[AuthCtx] extends [never] ? true : false, false>>,
	Assert<Equal<KCustomCtx<typeof plain>['extra'], number>>,
	Assert<Equal<KCustomCtx<'not a builder'>, never>>,
] = [true, true, true, true, true]
void ctxAssertions

/** One parameter type for any k schema, with the members helpers need. */
function optionalOutput(schema: AnyKSchema) {
	return { optional: schema.optional(), output: schema.outputValidator, parsed: schema.parse(1) }
}
optionalOutput(k.string())
optionalOutput(k.object({ a: k.number().default(1) }))
optionalOutput(k.string().refine((value): value is 'a' => value === 'a'))
optionalOutput(k.array(k.id('tasks')).optional())
const key: KRecordKey = k.string()
const cursor: KCursorSchema = k.object({ at: k.number() })
void key
void cursor

function asParameter(schema: AnyKSchema) {
	return schema.optional().outputValidator
}
for (const schema of [
	k.number(),
	k.string().min(1),
	k.object({ a: k.int().default(1) }),
	k.enum(['a']),
])
	asParameter(schema)
function keepsType<S extends KType>(schema: S & AnyKSchema): KOptional<S> {
	// SAFETY: a k schema's optional() is KOptional of that schema.
	return schema.optional() as KOptional<S>
}
const kept: KOptional<KString> = keepsType(k.string())
void kept
