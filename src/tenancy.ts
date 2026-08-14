import {
	wrapDatabaseReader,
	wrapDatabaseWriter,
	type RLSConfig,
	type Rules,
} from 'convex-helpers/server/rowLevelSecurity'
import type {
	GenericDataModel,
	TableNamesInDataModel,
} from 'convex/server'
import { defaultErrors, type ErrorFactory } from './errors'

export { wrapDatabaseReader, wrapDatabaseWriter }
export type { RLSConfig, Rules }

/** The server-owned tenancy field stamped on every tenant table row. */
export const TENANT_FIELD = 'tenant' as const

type TenantRow = { [TENANT_FIELD]?: unknown }

/**
 * Deny-oriented row-level security rules generated mechanically from a table
 * registry: read/insert/modify pass only when the row's tenant matches.
 * Registering a table here is the entire onboarding — there is no second
 * per-table step to forget.
 */
export function createTenantRules<DataModel extends GenericDataModel>(
	tenant: string,
	tables: readonly TableNamesInDataModel<DataModel>[],
): Rules<unknown, DataModel> {
	const owned = async (_ctx: unknown, doc: TenantRow) =>
		doc[TENANT_FIELD] === tenant
	return Object.fromEntries(
		tables.map((table) => [
			table,
			{ read: owned, insert: owned, modify: owned },
		]),
	) as unknown as Rules<unknown, DataModel>
}

/**
 * AND-composes rule sets: a row passes an operation only when every rule set
 * that defines a rule for it passes. Lets tenant isolation and role-level
 * rules coexist on the same wrapped database.
 */
export function composeRules<Ctx, DataModel extends GenericDataModel>(
	...sets: readonly Rules<Ctx, DataModel>[]
): Rules<Ctx, DataModel> {
	const tables = new Set(sets.flatMap((set) => Object.keys(set)))
	const composed: Record<string, Record<string, unknown>> = {}
	for (const table of tables) {
		const operations: Record<string, unknown> = {}
		for (const operation of ['read', 'insert', 'modify'] as const) {
			const rules = sets
				.map((set) => (set as Record<string, Record<string, unknown>>)[table])
				.map((tableRules) => tableRules?.[operation])
				.filter((rule): rule is (ctx: Ctx, doc: never) => Promise<boolean> =>
					typeof rule === 'function',
				)
			if (rules.length === 0) continue
			operations[operation] = async (ctx: Ctx, doc: never) => {
				for (const rule of rules) {
					if (!(await rule(ctx, doc))) return false
				}
				return true
			}
		}
		composed[table] = operations
	}
	return composed as Rules<Ctx, DataModel>
}

/**
 * Loads a client-referenced document and verifies tenant ownership without
 * disclosing existence: a missing row and a foreign row fail identically
 * with REFERENCE_NOT_FOUND. Use for every id argument a client supplies.
 */
export async function requireTenantReference<
	Document extends { [TENANT_FIELD]?: unknown },
>(
	tenant: string,
	load: () => Promise<Document | null>,
	errors: ErrorFactory = defaultErrors,
): Promise<Document> {
	const document = await load()
	if (!document || document[TENANT_FIELD] !== tenant) {
		return errors.throw({
			code: 'REFERENCE_NOT_FOUND',
			message: 'The referenced row is unavailable',
		})
	}
	return document
}

/** Asserts a loaded document belongs to the tenant; use on internal paths. */
export function assertTenantOwned<
	Document extends { [TENANT_FIELD]?: unknown },
>(
	tenant: string,
	document: Document,
	errors: ErrorFactory = defaultErrors,
): Document {
	if (document[TENANT_FIELD] !== tenant) {
		return errors.throw({
			code: 'CROSS_TENANT_REFERENCE',
			message: 'The document belongs to another tenant',
		})
	}
	return document
}
