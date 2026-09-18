import {
	wrapDatabaseReader,
	wrapDatabaseWriter,
	type RLSConfig,
	type Rules,
} from 'convex-helpers/server/rowLevelSecurity'
import type { GenericDataModel, TableNamesInDataModel } from 'convex/server'
import { defaultErrors, type ErrorFactory } from './errors'

export { wrapDatabaseReader, wrapDatabaseWriter }
export type { RLSConfig, Rules }

/** The server-owned tenancy field stamped on every tenant table row. */
export const TENANT_FIELD = 'tenant' as const

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
	const rules: Rules<unknown, DataModel> = {}
	for (const table of tables) {
		rules[table] = {
			read: async (_context, document) => document[TENANT_FIELD] === tenant,
			insert: async (_context, document) => document[TENANT_FIELD] === tenant,
			modify: async (_context, document) => document[TENANT_FIELD] === tenant,
		}
	}
	return rules
}

/**
 * AND-composes rule sets: a row passes an operation only when every rule set
 * that defines a rule for it passes. Lets tenant isolation and role-level
 * rules coexist on the same wrapped database.
 */
export function composeRules<Ctx, DataModel extends GenericDataModel>(
	...sets: readonly Rules<Ctx, DataModel>[]
): Rules<Ctx, DataModel> {
	// SAFETY: Rules keys are table names from DataModel; values come only from the supplied rule sets.
	const tables = new Set(sets.flatMap((set) => Object.keys(set))) as Set<
		TableNamesInDataModel<DataModel>
	>
	const composed: Rules<Ctx, DataModel> = {}
	for (const table of tables) {
		const reads = sets.flatMap((set) => set[table]?.read ?? [])
		const inserts = sets.flatMap((set) => set[table]?.insert ?? [])
		const modifies = sets.flatMap((set) => set[table]?.modify ?? [])
		const rules: NonNullable<Rules<Ctx, DataModel>[typeof table]> = {}
		if (reads.length)
			rules.read = async (context, document) => {
				for (const rule of reads) if (!(await rule(context, document))) return false
				return true
			}
		if (inserts.length)
			rules.insert = async (context, document) => {
				for (const rule of inserts) if (!(await rule(context, document))) return false
				return true
			}
		if (modifies.length)
			rules.modify = async (context, document) => {
				for (const rule of modifies) if (!(await rule(context, document))) return false
				return true
			}
		composed[table] = rules
	}
	return composed
}

/**
 * Loads a client-referenced document and verifies tenant ownership without
 * disclosing existence: a missing row and a foreign row fail identically
 * with REFERENCE_NOT_FOUND. Use for every id argument a client supplies.
 */
export async function requireTenantReference<Document extends { [TENANT_FIELD]?: unknown }>(
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
export function assertTenantOwned<Document extends { [TENANT_FIELD]?: unknown }>(
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
