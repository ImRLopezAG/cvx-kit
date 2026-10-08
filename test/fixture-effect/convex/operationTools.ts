import {
	bindOperationExecutor,
	createOperationTools,
	operationToolDialect,
	selectOperation,
} from 'cvx-kit/agent-tools'
import { v } from 'convex/values'
import { createAuthFunctions } from 'cvx-kit/auth'
import { createEffectFoundation, effectZodApiBuilder } from 'cvx-kit/effect'
import { zid } from 'cvx-kit/zod-table'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import type { GenericDatabaseReader } from 'convex/server'
import { api, internal } from './_generated/api'
import { declaredErrors } from './domain'
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import { nativeIdempotencyOperation } from './idempotency'
import type { DataModel, Id } from './_generated/dataModel'

type ToolOutcome =
	| { _tag: 'Success'; value: { id: Id<'idempotentNotes'>; title: string } }
	| { _tag: 'UnknownFailure'; version: 1 }
type QueryToolOutcome =
	| { _tag: 'Success'; value: { title: string } | null }
	| { _tag: 'UnknownFailure'; version: 1 }

const auth = createAuthFunctions<DataModel, 'owner' | 'viewer'>({
	query,
	mutation,
	action,
	internalQuery,
	internalMutation,
	internalAction,
	getAuthUser: async (ctx) => {
		const identity = await ctx.auth.getUserIdentity()
		return identity ? { id: identity.subject } : null
	},
	mapRole: (role) => (role === 'owner' || role === 'viewer' ? role : null),
	adminRoles: ['owner'],
	security: { tenancy: { tables: ['crudNotes'] } },
})
type QueryHost = { db: GenericDatabaseReader<DataModel>; role: string | null }
const queryInput = z.object({ id: zid('crudNotes') }).strict()
const queryResult = z.object({ title: z.string() }).strict().nullable()
const queryFoundation = createEffectFoundation({
	writeAudit: () => Effect.void,
	observability: {
		enabled: false,
		classifyError: () => ({ outcome: 'failed', errorCode: 'OPERATION_TOOL_QUERY_FAILURE' }),
	},
	checkPermission: (host: QueryHost) =>
		host.role === 'owner' ? Effect.void : Effect.fail(new Error('OPERATION_TOOL_QUERY_DENIED')),
})
const queries = queryFoundation.Query({
	context: (host: QueryHost) => host,
	operations: ({ query }) => ({
		get: query({
			input: queryInput,
			result: queryResult,
			permission: 'notes.read',
			handler: async ({ id }, host) => {
				const row = await host.db.get(id)
				return row ? { title: row.title } : null
			},
		}),
	}),
})
const selectedQuery = queries.expose(Symbol('operation-tool-query'), 'get')
const securedQuery = effectZodApiBuilder(auth.authQuery, { services: () => Context.empty() })
export const getNote = securedQuery({
	args: queryInput.shape,
	returns: queryResult,
	handler: (ctx, args) => queries.exec('get', args, ctx),
})

export const invokeQuery = action({
	// Raw strings reach the registered query's native table-specific validator.
	args: {
		id: v.string(),
		tenant: v.optional(v.string()),
		actor: v.optional(v.string()),
		permission: v.optional(v.string()),
	},
	returns: v.union(
		v.object({
			_tag: v.literal('Success'),
			value: v.union(v.null(), v.object({ title: v.string() })),
		}),
		v.object({ _tag: v.literal('UnknownFailure'), version: v.literal(1) }),
	),
	handler: async (ctx, args): Promise<QueryToolOutcome> => {
		const executor = bindOperationExecutor(selectedQuery, {
			owner: selectedQuery.owner,
			key: selectedQuery.key,
			// SAFETY: Preserve raw strings and extra fields without decoding here. The
			// registered query's v.id and closed args validator establish validity.
			execute: (raw) =>
				ctx.runQuery(api.operationTools.getNote, { ...raw, id: raw.id as Id<'crudNotes'> }),
		})
		const tools = createOperationTools({
			getNote: {
				operation: selectedQuery,
				executor,
				description: 'Read only the public note title through its secured native query',
				converter: {
					dialect: operationToolDialect,
					convert: () => ({
						type: 'object',
						properties: { id: { type: 'string' } },
						required: ['id'],
						additionalProperties: false,
					}),
				},
			},
		})
		return tools.getNote.invoke(args)
	},
})

// The host deliberately represents the raw string transport. Domain trimming
// and normalization stay inside the same secured mutation used by direct API calls.
const converter = {
	dialect: operationToolDialect,
	convert: () => ({
		type: 'object',
		properties: { title: { type: 'string' } },
		required: ['title'],
		additionalProperties: false,
	}),
}

export const invoke = action({
	args: {
		key: v.string(),
		// Test-only wrapper admits forged fields so the tool reaches the secured
		// mutation's closed native validator; these fields never supply authority.
		payload: v.object({
			title: v.string(),
			tenant: v.optional(v.string()),
			actor: v.optional(v.string()),
			permission: v.optional(v.string()),
		}),
		mode: v.optional(
			v.union(
				v.literal('success'),
				v.literal('audit'),
				v.literal('completion'),
				v.literal('result'),
				v.literal('cleanup'),
			),
		),
	},
	returns: v.union(
		v.object({
			_tag: v.literal('Success'),
			value: v.object({ id: v.id('idempotentNotes'), title: v.string() }),
		}),
		v.object({ _tag: v.literal('UnknownFailure'), version: v.literal(1) }),
	),
	handler: async (ctx, args): Promise<ToolOutcome> => {
		const executor = bindOperationExecutor(nativeIdempotencyOperation, {
			owner: nativeIdempotencyOperation.owner,
			key: nativeIdempotencyOperation.key,
			execute: (payload) =>
				ctx.runMutation(
					api.idempotency.save,
					args.mode === undefined
						? { key: args.key, payload }
						: { key: args.key, payload, mode: args.mode },
				),
		})
		const tools = createOperationTools({
			createNote: {
				operation: nativeIdempotencyOperation,
				executor,
				converter,
				description: 'Create a note through its secured domain mutation',
			},
		})
		return tools.createNote.invoke(args.payload)
	},
})

const selectedFailure = selectOperation(Symbol('native-failure-tool'), 'mutation', 'fail', {
	input: z.object({ key: z.string(), composite: z.boolean() }).strict(),
	result: z.null(),
})
export const invokeDeclaredFailure = action({
	args: { key: v.string(), composite: v.boolean() },
	returns: v.union(
		v.object({ _tag: v.literal('Success'), value: v.null() }),
		v.object({
			_tag: v.literal('DeclaredFailure'),
			version: v.literal(1),
			code: v.literal('DENIED'),
			message: v.string(),
			details: v.object({ key: v.string() }),
		}),
		v.object({ _tag: v.literal('UnknownFailure'), version: v.literal(1) }),
	),
	handler: async (
		ctx,
		args,
	): Promise<{ _tag: 'Success'; value: null } | ReturnType<typeof declaredErrors.decode>> => {
		const executor = bindOperationExecutor(selectedFailure, {
			owner: selectedFailure.owner,
			key: selectedFailure.key,
			execute: (raw) => ctx.runMutation(internal.functions.declaredFailure, raw),
		})
		const tools = createOperationTools({
			fail: {
				operation: selectedFailure,
				executor,
				errors: declaredErrors,
				description: 'Project a declared failure after native rollback',
				converter: {
					dialect: operationToolDialect,
					convert: () => ({
						type: 'object',
						properties: { key: { type: 'string' }, composite: { type: 'boolean' } },
						required: ['key', 'composite'],
						additionalProperties: false,
					}),
				},
			},
		})
		return tools.fail.invoke(args)
	},
})
