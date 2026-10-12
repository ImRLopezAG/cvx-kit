import type { GenericId } from 'convex/values'
import {
	createQueryEngine,
	type QueryEngineConfig,
	type QueryEngineDeclaration,
	type QueryEngineOptions,
} from '../src/querying'
import type { ManagedQueryContext } from '../src/querying/security'
import type { RelationRegistry } from '../src/relations'
import { cursor, declarations, type DM } from './fixture-querying/scalar'

const f = declarations()
type RegistryTypes =
	typeof f.relations extends RelationRegistry<infer Tables, infer D> ? [Tables, D] : never
type Config = QueryEngineDeclaration<typeof f.schema, RegistryTypes[0], RegistryTypes[1]>
type Assert<T extends true> = T
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export type MinimalConfig = Assert<Equal<keyof Config, 'schema' | 'relations'>>
const config: Config = { schema: f.schema, relations: f.relations }
const simple = createQueryEngine(config)
const preferred: (config: Config, options?: QueryEngineOptions<typeof f.schema>) => typeof simple =
	createQueryEngine
void preferred
const advanced = createQueryEngine(config, {
	cursor,
	budgets: { rawCandidates: 10 },
	maxPageSize: 10,
	policyVersion: 'p2',
	engineVersion: 'e2',
	trustedAdapter: (ctx) => ({
		reader: ctx.db,
		scope: { mode: 'trusted', principal: null, tenant: null, organization: null, role: null },
		rules: {},
		defaultPolicy: 'allow',
	}),
})
const legacyConfig: QueryEngineConfig<typeof f.schema, RegistryTypes[0], RegistryTypes[1]> = {
	...config,
	cursor,
	maxPageSize: 10,
}
const legacy = createQueryEngine(legacyConfig)
declare const ctx: ManagedQueryContext<DM>
for (const engine of [simple, advanced, legacy]) {
	engine(ctx)
		.tasks.paginate({ numItems: 1, cursor: null })
		.then((page) => {
			const id: GenericId<'tasks'> = page.page[0]._id
			void id
			// @ts-expect-error public DTOs exclude storage secrets
			void page.page[0].secret
		})
	// @ts-expect-error unknown table keys stay absent
	void engine(ctx).missing
	// @ts-expect-error native bigint filter types stay intact
	engine(ctx).tasks.where({ big: 1 })
}
// @ts-expect-error advanced fields are absent from the minimal named config
const clutter: Config = { ...config, cursor }
void clutter
// @ts-expect-error a second argument must be an options object
createQueryEngine(config, { maxPageSize: '10' })
// @ts-expect-error request scope is not engine configuration
createQueryEngine(config, { principal: 'user' })
