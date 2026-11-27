import { z } from 'zod'
import { zid } from 'convex-helpers/server/zod4'
import { queryGeneric as authQuery } from 'convex/server'
import { relations } from './relations'

export const NoteArgs = z.strictObject({ id: zid('notes') })

export const get = authQuery({
	args: NoteArgs,
	returns: z.strictObject({ title: z.string() }),
	handler: async (_ctx, args) => args.id,
})

export const list = authQuery({
	args: relations.tables.notes.paginationOpts({ title: true }),
	returns: relations.tables.notes.pageDto({}),
	handler: async () => null,
})

export const shared = authQuery({
	args: schemas.byId,
	returns: z.null(),
	handler: async () => null,
})

export const notAFunction = configure({ args: { id: zid('notes') } })
