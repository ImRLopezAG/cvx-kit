import type { GenericDatabaseWriter } from 'convex/server'
import { v } from 'convex/values'
import { createAuthFunctions } from 'cvx-kit/auth'
import { createEffectFoundation, effectZodApiBuilder } from 'cvx-kit/effect'
import { defineErrorContract } from 'cvx-kit/errors'
import { zid } from 'cvx-kit/zod-table'
import { Context, Effect } from 'effect'
import { z } from 'zod'
import type { DataModel, Id } from './_generated/dataModel'
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from './_generated/server'
import { crudNotes } from './schema'

const errors = defineErrorContract({
	MISSING: { message: 'Note missing', details: { id: z.string() } },
	AFTER_PATCH: { message: 'Rename rejected after patch', details: { id: z.string() } },
})

interface Repository {
	get(id: Id<'crudNotes'>): Promise<{ title: string } | null>
	rename(id: Id<'crudNotes'>, title: string): Promise<void>
}
class Notes extends Context.Service<Notes, Repository>()('NativeAsyncDomainNotes') {}

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
	mapRole: (slug) => (slug === 'owner' || slug === 'viewer' ? slug : null),
	adminRoles: ['owner'],
	security: {
		tenancy: { tables: ['crudNotes'] },
		rules: (bundle) => ({
			crudNotes: {
				modify: async (_ctx, row) => bundle.role === 'owner' && row.owner === bundle.actor.userId,
			},
			crudAudits: { insert: async () => bundle.role === 'owner' },
			writes: { insert: async () => bundle.role === 'owner' },
		}),
	},
})

function repository(db: GenericDatabaseWriter<DataModel>, actor: string): Repository {
	return {
		get: async (id) => {
			const row = await db.get(id)
			return row && row.owner === actor ? { title: row.title } : null
		},
		rename: async (id, title) => {
			await db.patch(id, { title })
		},
	}
}

const securedMutation = effectZodApiBuilder(auth.authMutation, {
	services: (ctx) => Context.make(Notes, repository(ctx.db, ctx.actor.userId)),
	errors,
})

type Host = {
	db: GenericDatabaseWriter<DataModel>
	actor: { userId: string }
	role: 'owner' | 'viewer' | null
	id: Id<'crudNotes'>
	failAfterPatch: boolean
}

export const rename = securedMutation({
	// The native API accepts raw text. Only the domain input decoder transforms it.
	args: { id: zid('crudNotes'), title: z.string(), failAfterPatch: z.boolean().optional() },
	returns: crudNotes.publicDto.strict(),
	handler: (ctx, args) => {
		// Each registration execution has its own decoder and counters, including retries.
		let transforms = 0
		const events: string[] = []
		const input = z
			.object({
				id: zid('crudNotes'),
				title: z.string().transform(async (title) => {
					await Promise.resolve()
					transforms += 1
					events.push('decode')
					return title.trim().toLowerCase()
				}),
			})
			.strict()
		const foundation = createEffectFoundation({
			observability: {
				enabled: false,
				classifyError: () => ({ outcome: 'failed', errorCode: 'ASYNC_DOMAIN_FAILURE' }),
			},
			checkPermission: (host: Host) => {
				events.push('permission')
				if (transforms !== 1 || events.join(',') !== 'decode,permission')
					throw new Error('ASYNC_DOMAIN_DECODE_ORDER')
				if (host.role !== 'owner') throw new Error('ASYNC_DOMAIN_DENIED')
			},
			writeAudit: (host: Host, entry) =>
				Effect.gen(function* () {
					yield* Effect.promise(() =>
						host.db.insert('crudAudits', {
							operation: entry.operation,
							actor: entry.actorId,
							id: entry.aggregate.id,
						}),
					)
					events.push('audit')
					if (host.failAfterPatch)
						return yield* Effect.fail(errors.create('AFTER_PATCH', { id: host.id }))
				}),
		})
		const commands = foundation.Command({
			context: (host: Host) => host,
			operations: ({ command }) => ({
				rename: command({
					input,
					result: crudNotes.publicDto.strict(),
					classification: 'business',
					permission: 'notes:rename',
					handler: (decoded) =>
						Effect.gen(function* () {
							const notes = yield* Notes
							if (transforms !== 1) throw new Error('ASYNC_DOMAIN_DECODE_COUNT')
							events.push(`handler:${decoded.title}`)
							const current = yield* Effect.promise(() => notes.get(decoded.id))
							if (!current) return yield* Effect.fail(errors.create('MISSING', { id: decoded.id }))
							yield* Effect.promise(() => notes.rename(decoded.id, decoded.title))
							events.push('patch')
							return { title: decoded.title }
						}),
					audit: (_resolution, host) => ({
						operation: 'asyncDomain.rename',
						actorId: host.actor.userId,
						aggregate: { type: 'note', id: host.id },
					}),
				}),
			}),
		})
		const host: Host = { ...ctx, id: args.id, failAfterPatch: args.failAfterPatch ?? false }
		return commands.exec('rename', { id: args.id, title: args.title }, host).pipe(
			Effect.tap(() =>
				Effect.promise(async () => {
					if (transforms !== 1) throw new Error('ASYNC_DOMAIN_DECODE_COUNT')
					await ctx.db.insert('writes', {
						key: args.id,
						stage: JSON.stringify({ transforms, events }),
					})
				}),
			),
		)
	},
})

// Independent raw observer; the successful mutation does not return its counters.
export const proof = internalQuery({
	args: { id: v.id('crudNotes') },
	returns: v.array(v.string()),
	handler: async (ctx, { id }) =>
		(
			await ctx.db
				.query('writes')
				.withIndex('by_key', (q) => q.eq('key', id))
				.take(20)
		).map((row) => row.stage),
})
