import { k } from 'cvx-kit'
import { authQuery } from './auth'
import { relations } from './relations'

export const NoteArgs = k.strictObject({ id: k.id('notes') })

export const get = authQuery({
	args: NoteArgs,
	get returns() { return k.strictObject({ title: k.string() }) },
	handler: async (_ctx, args) => args.id,
})

export const list = authQuery({
	args: relations.tables.notes.paginationOpts({ title: true }),
	returns: relations.tables.notes.pageDto({}),
	handler: async () => null,
})

export const shared = authQuery({
	args: schemas.byId,
	get returns() { return k.null() },
	handler: async () => null,
})

export const notAFunction = configure({ args: { id: k.id('notes') } })

export const voidResult = authQuery({
	get returns() { return k.void() },
	handler: async () => {},
})
