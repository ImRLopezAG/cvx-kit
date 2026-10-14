import type { GenericId } from 'convex/values'
import { z } from 'zod'
import { createTable, zid, zodTable } from '../src/zod-table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const shared = {
	owner: zid('users'),
	note: z.string().optional(),
	secret: z.string(),
	size: z.string().transform((value) => value.length),
}
const fields = (id: typeof zid) => ({ title: z.string(), parent: id('tasks').optional() })
const options = {
	serverFields: ['secret'],
	commandFields: ['title', 'size', 'owner'],
	publicFields: ['title', 'owner', 'note', 'createdAt'],
} as const
const customTable = createTable(shared)
const tasks = customTable('tasks', fields, options)
const canonical = zodTable('tasks', (id) => ({ ...shared, ...fields(id) }), options)
const assertions: [
	Assert<Equal<z.input<typeof tasks.storage>, z.input<typeof canonical.storage>>>,
	Assert<Equal<z.input<typeof tasks.storage>['size'], string>>,
	Assert<Equal<z.output<typeof tasks.storage>['size'], number>>,
	Assert<Equal<typeof tasks.tableName, 'tasks'>>,
	Assert<Equal<z.output<typeof tasks.schema>['_id'], GenericId<'tasks'>>>,
	Assert<Equal<z.output<typeof tasks.storage>['owner'], GenericId<'users'>>>,
	Assert<Equal<z.output<typeof tasks.insertSchema>['note'], string | undefined>>,
] = [true, true, true, true, true, true, true]
void assertions
const sameBoundary: typeof canonical = tasks
const sameCustomBoundary: typeof tasks = canonical
void sameBoundary
void sameCustomBoundary
const insert = tasks.insert({ owner: true })
const update = tasks.update({ note: true })
const dto = tasks.dto({ _id: true, extend: { label: z.string() } })
const maskAssertions: [
	Assert<Equal<'owner' extends keyof z.input<typeof insert> ? true : false, false>>,
	Assert<Equal<'note' extends keyof z.output<typeof update> ? true : false, false>>,
	Assert<Equal<z.output<typeof dto>['_id'], GenericId<'tasks'>>>,
	Assert<Equal<z.output<typeof dto>['label'], string>>,
	Assert<Equal<keyof z.input<typeof tasks.commandInput>, 'title' | 'size' | 'owner'>>,
	Assert<Equal<keyof z.output<typeof tasks.publicDto>, 'title' | 'owner' | 'note' | 'createdAt'>>,
] = [true, true, true, true, true, true]
void maskAssertions
tasks.table.index('by_owner', ['owner'])
tasks.paginationOpts({ owner: true, size: true, _id: true })
const ordinary = customTable('issues', () => ({ severity: z.number() }))
const ordinaryCanonical = zodTable('issues', () => ({ ...shared, severity: z.number() }))
const ordinaryChecks: [
	Assert<Equal<z.output<typeof ordinary.schema>['_id'], GenericId<'issues'>>>,
	Assert<Equal<z.input<typeof ordinary.insertSchema>['secret'], string>>,
	Assert<
		Equal<z.output<typeof ordinary.commandInput>, z.output<typeof ordinaryCanonical.commandInput>>
	>,
] = [true, true, true]
void ordinaryChecks
const reusableShared = Object.fromEntries([['common', z.string()]])
createTable(reusableShared)('dynamic', () => ({ title: z.string() }))

const toolUpdateChecks: [
	Assert<Equal<z.output<typeof tasks.tools.update>['id'], GenericId<'tasks'>>>,
	Assert<Equal<z.input<typeof tasks.tools.update>['data']['size'], string | undefined>>,
	Assert<Equal<z.output<typeof tasks.tools.update>['data']['size'], number | undefined>>,
] = [true, true, true]
void toolUpdateChecks

// @ts-expect-error shared fields cannot be overwritten
customTable('tasks', () => ({ owner: zid('users') }))
const duplicate = () => ({ title: z.string(), note: z.string() })
// @ts-expect-error reused callbacks cannot overwrite shared fields
customTable('tasks', duplicate)
// @ts-expect-error a duplicate cannot be hidden among unique declared fields
customTable('tasks', () => ({ title: z.string(), secret: z.string() }))
// @ts-expect-error reserved shared storage fields
createTable({ _id: z.string() })
// @ts-expect-error reserved shared creation time
createTable({ _creationTime: z.number() })
// @ts-expect-error reserved shared timestamp
createTable({ createdAt: z.number() })
// @ts-expect-error reserved shared timestamp
createTable({ updatedAt: z.number() })
// @ts-expect-error reserved shared timestamp
createTable({ archivedAt: z.number() })
// @ts-expect-error declared reserved fields
customTable('tasks', () => ({ _id: z.string() }))
// @ts-expect-error declared reserved timestamp
customTable('tasks', () => ({ updatedAt: z.number() }))
// @ts-expect-error command allowlist cannot contain server-owned shared fields
customTable('tasks', fields, { serverFields: ['secret'], commandFields: ['secret'] })
// @ts-expect-error unknown shared/specific allowlist field
customTable('tasks', fields, { publicFields: ['missing'] })
// @ts-expect-error server ownership cannot reference another table's fields
customTable('tasks', fields, { serverFields: ['severity'] })
// @ts-expect-error absent specific fields cannot be indexed
ordinary.table.index('by_title', ['title'])
// @ts-expect-error masks reject unknown keys
tasks.insert({ missing: true })
const invalidCommand: z.input<typeof tasks.tools.insert> = {
	title: 't',
	size: 's',
	owner: zid('users').parse('users:1'),
	// @ts-expect-error command fields exclude note
	note: 'n',
}
void invalidCommand
