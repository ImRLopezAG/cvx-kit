// Type tests for the v2 kTable family; checked by `bun run typecheck`, never executed.
import type { GenericId } from 'convex/values'
import { k } from '../src/k'
import { createTable, kTable, tenantTable } from '../src/table'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const documents = kTable(
	'documents',
	{
		title: k.string().trim(),
		ownerId: k.id('users'),
		note: k.string().optional(),
		secret: k.string(),
		reviewState: k.enum(['draft', 'published']).default('draft'),
	},
	{
		serverFields: ['secret'],
		commandFields: ['title', 'note', 'reviewState'],
		publicFields: ['title', 'ownerId', 'reviewState', 'createdAt'],
	},
)

type Document = k.infer<typeof documents.schema>
type Stored = k.input<typeof documents.storage>
type Insert = k.input<typeof documents.insertSchema>
type Command = k.input<typeof documents.commandInput>
type Public = k.infer<typeof documents.publicDto>

const documentChecks: [
	Assert<Equal<Document['_id'], GenericId<'documents'>>>,
	Assert<Equal<Document['_creationTime'], number>>,
	Assert<Equal<Document['ownerId'], GenericId<'users'>>>,
	Assert<Equal<Document['createdAt'], number | undefined>>,
	Assert<Equal<typeof documents.tableName, 'documents'>>,
	// AE1: the defaulted field is optional on insert and in the stored document, required when public.
	Assert<Equal<Insert['reviewState'], 'draft' | 'published' | undefined>>,
	Assert<Equal<Stored['reviewState'], 'draft' | 'published' | undefined>>,
	Assert<Equal<Public['reviewState'], 'draft' | 'published'>>,
	Assert<Equal<keyof Insert, 'title' | 'ownerId' | 'note' | 'reviewState'>>,
	Assert<Equal<keyof Command, 'title' | 'note' | 'reviewState'>>,
	Assert<Equal<keyof Public, 'title' | 'ownerId' | 'reviewState' | 'createdAt'>>,
	Assert<Equal<k.infer<typeof documents.updateSchema>['title'], string | undefined>>,
	Assert<Equal<keyof k.input<typeof documents.updateSchema>, keyof Insert>>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true]
void documentChecks

// Index field paths typecheck against the stored fields, timestamps included.
documents.table.index('by_owner', ['ownerId']).index('by_owner_created', ['ownerId', 'createdAt'])
// @ts-expect-error an index cannot name an undeclared field
documents.table.index('by_missing', ['missing'])

const insertOmit = documents.insert('ownerId')
const updateOmit = documents.update('note')
const maskChecks: [
	Assert<Equal<keyof k.input<typeof insertOmit>, 'title' | 'note' | 'reviewState'>>,
	Assert<Equal<'note' extends keyof k.input<typeof updateOmit> ? true : false, false>>,
] = [true, true]
void maskChecks
// @ts-expect-error masks accept only insert fields
documents.insert('secret')

// DTOs.
const row = {
	title: 't',
	ownerId: k.id('users').parse('users:1'),
	secret: 's',
	_id: k.id('documents').parse('documents:1'),
}
const ordinary = documents.toPublicDto(row)
const withId = documents.toPublicDto(row, true)
const explicit = documents.toPublicDto(row, { _id: true })
const extend = { url: k.string(), extra: k.number().optional() }
const extended = documents.toPublicDto(row, { _id: true, extend, values: { url: 'u' } })
const extendedSchema = documents.dto({ _id: true, extend })
const dtoChecks: [
	Assert<Equal<typeof withId._id, GenericId<'documents'>>>,
	Assert<Equal<typeof explicit, typeof withId>>,
	Assert<Equal<typeof ordinary, Public>>,
	Assert<Equal<k.infer<ReturnType<typeof documents.dto<true>>>, typeof withId>>,
	Assert<Equal<k.infer<typeof extendedSchema>, typeof extended>>,
	Assert<Equal<typeof extended.extra, number | undefined>>,
	Assert<Equal<k.infer<typeof documents.tools.update>['id'], GenericId<'documents'>>>,
	Assert<Equal<keyof k.input<typeof documents.tools.update>['data'], keyof Command>>,
] = [true, true, true, true, true, true, true, true]
void dtoChecks
// @ts-expect-error unselected fields remain absent
void ordinary.secret
// @ts-expect-error a requested id requires an id-bearing row
documents.toPublicDto({ title: 't', ownerId: row.ownerId, secret: 's' }, true)
// @ts-expect-error extension values are required
documents.toPublicDto(row, { extend })
// @ts-expect-error extension values must match their schemas
documents.toPublicDto(row, { extend, values: { url: 1 } })
// @ts-expect-error projected collisions are rejected
documents.dto({ extend: { title: k.number() } })
// @ts-expect-error reserved names are rejected
documents.dto({ extend: { createdAt: k.number() } })
// @ts-expect-error a transform extension is rejected
documents.dto({ extend: { size: k.string().transform((value) => value.length) } })

// Field lists accept declared field names only.
// @ts-expect-error unknown command field
kTable('t', { a: k.string() }, { commandFields: ['missing'] })
// @ts-expect-error unknown public field
kTable('t', { a: k.string() }, { publicFields: ['missing'] })
// @ts-expect-error unknown server field
kTable('t', { a: k.string() }, { serverFields: ['missing'] })
// @ts-expect-error a timestamp cannot be a command field
kTable('t', { a: k.string() }, { commandFields: ['createdAt'] })
// @ts-expect-error a server-owned field cannot be a command field
kTable('t', { a: k.string() }, { serverFields: ['a'], commandFields: ['a'] })
kTable('t', { a: k.string() }, { publicFields: ['a', 'createdAt', 'updatedAt', 'archivedAt'] })

// Reserved names and transforms.
// @ts-expect-error reserved system field
kTable('t', { _id: k.string() })
// @ts-expect-error reserved timestamp
kTable('t', { updatedAt: k.number() })
// @ts-expect-error a transform field is a type error (AE2)
kTable('t', { size: k.string().transform((value) => value.length) })
// @ts-expect-error a pipe field is a type error
kTable('t', { size: k.string().pipe(k.string()) })
// Type-preserving normalisers are allowed (AE3).
kTable('t', {
	title: k
		.string()
		.trim()
		.toLowerCase()
		.overwrite((value) => value),
})

// tenantTable.
const items = tenantTable(
	'items',
	{ name: k.string(), approver: k.id('users') },
	{ serverFields: ['approver'], commandFields: ['name'], publicFields: ['name', 'tenant'] },
)
const tenantChecks: [
	Assert<Equal<k.infer<typeof items.storage>['tenant'], string>>,
	Assert<Equal<keyof k.input<typeof items.insertSchema>, 'name'>>,
	Assert<Equal<keyof k.infer<typeof items.publicDto>, 'name' | 'tenant'>>,
] = [true, true, true]
void tenantChecks
items.table.index('by_tenant', ['tenant', 'name'])
// @ts-expect-error tenant is injected
tenantTable('t', { tenant: k.string() })
// @ts-expect-error tenant is server-owned
tenantTable('t', { name: k.string() }, { commandFields: ['tenant'] })

// createTable.
const shared = { owner: k.id('users'), note: k.string().optional(), secret: k.string() }
const customTable = createTable(shared)
const tasks = customTable(
	'tasks',
	{ title: k.string(), parent: k.id('tasks').optional() },
	{
		serverFields: ['secret'],
		commandFields: ['title', 'owner'],
		publicFields: ['title', 'owner', 'note', 'createdAt'],
	},
)
const canonical = kTable(
	'tasks',
	{ ...shared, title: k.string(), parent: k.id('tasks').optional() },
	{
		serverFields: ['secret'],
		commandFields: ['title', 'owner'],
		publicFields: ['title', 'owner', 'note', 'createdAt'],
	},
)
const sharedChecks: [
	Assert<Equal<k.input<typeof tasks.storage>, k.input<typeof canonical.storage>>>,
	Assert<Equal<k.infer<typeof tasks.schema>['_id'], GenericId<'tasks'>>>,
	Assert<Equal<keyof k.input<typeof tasks.commandInput>, 'title' | 'owner'>>,
	Assert<Equal<k.infer<typeof tasks.insertSchema>['note'], string | undefined>>,
] = [true, true, true, true]
void sharedChecks
tasks.table.index('by_owner', ['owner'])
// @ts-expect-error shared fields cannot be redeclared
customTable('tasks', { owner: k.id('users') })
// @ts-expect-error a duplicate cannot hide among unique fields
customTable('tasks', { title: k.string(), secret: k.string() })
// @ts-expect-error reserved shared field
createTable({ _id: k.string() })
// @ts-expect-error reserved shared timestamp
createTable({ archivedAt: k.number() })
// @ts-expect-error server-owned shared fields cannot be commands
customTable('tasks', { title: k.string() }, { serverFields: ['secret'], commandFields: ['secret'] })
// @ts-expect-error unknown shared or specific field
customTable('tasks', { title: k.string() }, { publicFields: ['missing'] })
const dynamicShared = createTable(Object.fromEntries([['common', k.string()]]))
dynamicShared('dynamic', { title: k.string() })
// @ts-expect-error a transform inside one union member is still a type error
kTable('t', { either: k.union([k.string().transform((value) => value.length), k.null()]) })

// Carried over from the v1 table type suite: DTO options and the scalar pagination boundary.
const disabled = documents.toPublicDto(row, false)
const explicitDisabled = documents.toPublicDto(row, { _id: false })
const defaultOptions = documents.toPublicDto(row, {})
const defaultExtended = documents.toPublicDto(row, { extend, values: { url: 'u' } })
const carriedDtoChecks: [
	Assert<Equal<typeof disabled, typeof ordinary>>,
	Assert<Equal<typeof explicitDisabled, typeof ordinary>>,
	Assert<Equal<typeof defaultOptions, typeof ordinary>>,
	Assert<Equal<k.infer<ReturnType<typeof documents.dto<false>>>, typeof ordinary>>,
	Assert<Equal<k.infer<typeof documents.publicDto>, typeof ordinary>>,
] = [true, true, true, true, true]
void carriedDtoChecks
// @ts-expect-error default extensions do not implicitly include an id
void defaultExtended._id
// @ts-expect-error an id-bearing DTO does not expose creation time
void withId._creationTime
// @ts-expect-error wrong table brand
const wrongTableId: GenericId<'users'> = withId._id
void wrongTableId
// @ts-expect-error values cannot be supplied without schemas
documents.toPublicDto(row, { values: { url: 'u' } })
// @ts-expect-error reserved id collisions are rejected even with id disabled
documents.dto({ _id: false, extend: { _id: k.string() } })
// @ts-expect-error creation time is reserved
documents.toPublicDto(row, { extend: { _creationTime: k.number() }, values: { _creationTime: 1 } })
// @ts-expect-error tenant ownership is reserved
documents.dto({ extend: { tenant: k.string() } })
documents.toPublicDto(row, {
	// @ts-expect-error extension keys remain known when some keys collide
	extend: { url: k.string(), title: k.string() },
	values: { url: 'u', title: 't' },
})
// @ts-expect-error a pipe extension is rejected
documents.toPublicDto(row, { extend: { name: k.string().pipe(k.string()) }, values: { name: 'n' } })

const filterTable = kTable(
	'filterRecords',
	{
		text: k.string(),
		count: k.number(),
		active: k.boolean(),
		owner: k.id('users').optional(),
		status: k.enum(['open', 'done']),
		object: k.object({ name: k.string() }),
		list: k.array(k.string()),
	},
	{ serverFields: ['active'] },
)
const pagination = filterTable.paginationOpts({
	text: true,
	count: true,
	owner: true,
	active: true,
	status: true,
	_id: true,
	_creationTime: true,
})
type PaginationInput = k.input<typeof pagination>
type PaginationOutput = k.output<typeof pagination>
declare const userId: GenericId<'users'>
declare const recordId: GenericId<'filterRecords'>
const validPagination: PaginationInput = {
	numItems: 1,
	cursor: null,
	order: 'desc',
	filters: {
		text: { gte: 'a' },
		count: { in: [1, 2] },
		active: false,
		owner: { eq: userId, exists: true },
		and: [{ status: 'open' }],
		_id: recordId,
	},
}
void validPagination
const paginationAssertions: [
	Assert<Equal<Extract<NonNullable<PaginationInput['filters']>['text'], string>, string>>,
	Assert<
		Equal<
			Extract<NonNullable<PaginationOutput['filters']>['_id'], string>,
			GenericId<'filterRecords'>
		>
	>,
] = [true, true]
void paginationAssertions
// @ts-expect-error unknown selections are rejected
filterTable.paginationOpts({ missing: true })
// @ts-expect-error false is not a selection
filterTable.paginationOpts({ text: false })
// @ts-expect-error nested objects are unsupported
filterTable.paginationOpts({ object: true })
// @ts-expect-error arrays are unsupported
filterTable.paginationOpts({ list: true })
const wrongOperator: PaginationInput = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error boolean ranges are unsupported
	filters: { active: { gt: true } },
}
const wrongIdRange: PaginationInput = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error id ranges are unsupported
	filters: { owner: { gt: userId } },
}
const wrongExists: PaginationInput = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error only optional fields support existence
	filters: { count: { exists: true } },
}
const wrongEnum: PaginationInput = {
	numItems: 1,
	cursor: null,
	// @ts-expect-error literal domain retained
	filters: { status: { eq: 'other' } },
}
// @ts-expect-error unselected fields remain unavailable
const wrongField: PaginationInput = { numItems: 1, cursor: null, filters: { createdAt: 1 } }
void [wrongOperator, wrongIdRange, wrongExists, wrongEnum, wrongField]
tenantTable(
	'valid',
	{ name: k.string() },
	{ publicFields: ['tenant', 'createdAt'] },
).paginationOpts({
	tenant: true,
	createdAt: true,
})

const nullableIdOpts = kTable('nullableIds', {
	owner: k.id('users').nullable(),
	mixed: k.union([k.id('users'), k.number()]),
}).paginationOpts({ owner: true, mixed: true })
const nullableIdAssertions: [
	Assert<
		Equal<
			Extract<NonNullable<k.output<typeof nullableIdOpts>['filters']>['owner'], string | null>,
			GenericId<'users'> | null
		>
	>,
] = [true]
void nullableIdAssertions
const nestedOpts = kTable('nullableEnum', {
	status: k.enum(['open', 'done']).nullable(),
}).paginationOpts({ status: true })
const nestedInput: k.input<typeof nestedOpts> = {
	numItems: 1,
	cursor: null,
	filters: { status: { in: ['open', null] } },
}
void nestedInput
const logicalOpts = kTable('logicalFields', {
	and: k.string(),
	or: k.number(),
	not: k.boolean(),
	fields: k.string(),
}).paginationOpts({ and: true, or: true, not: true, fields: true })
const logicalInput: k.input<typeof logicalOpts> = {
	numItems: 1,
	cursor: null,
	filters: {
		fields: { and: 'a', or: { gt: 0 }, not: false, fields: 'f' },
		and: [{ fields: { not: true } }],
	},
}
void logicalInput

// Carried over from the v1 createTable type suite.
const sameBoundary: typeof canonical = tasks
const sameCustomBoundary: typeof tasks = canonical
void [sameBoundary, sameCustomBoundary]
const sharedDto = tasks.dto({ _id: true, extend: { label: k.string() } })
const sharedMaskChecks: [
	Assert<
		Equal<
			'owner' extends keyof k.input<ReturnType<typeof tasks.insert<'owner'>>> ? true : false,
			false
		>
	>,
	Assert<Equal<k.infer<typeof sharedDto>['_id'], GenericId<'tasks'>>>,
	Assert<Equal<k.infer<typeof sharedDto>['label'], string>>,
	Assert<Equal<keyof k.infer<typeof tasks.publicDto>, 'title' | 'owner' | 'note' | 'createdAt'>>,
	Assert<Equal<k.infer<typeof tasks.tools.update>['id'], GenericId<'tasks'>>>,
] = [true, true, true, true, true]
void sharedMaskChecks
tasks.paginationOpts({ owner: true, _id: true })
const issues = customTable('issues', { severity: k.number() })
const issuesCanonical = kTable('issues', { ...shared, severity: k.number() })
const issueChecks: [
	Assert<Equal<k.infer<typeof issues.schema>['_id'], GenericId<'issues'>>>,
	Assert<Equal<k.input<typeof issues.insertSchema>['secret'], string>>,
	Assert<Equal<k.infer<typeof issues.commandInput>, k.infer<typeof issuesCanonical.commandInput>>>,
] = [true, true, true]
void issueChecks
// @ts-expect-error reserved shared creation time
createTable({ _creationTime: k.number() })
// @ts-expect-error declared reserved fields
customTable('tasks', { _id: k.string() })
// @ts-expect-error server ownership cannot reference another table's fields
customTable('tasks', { title: k.string() }, { serverFields: ['severity'] })
// @ts-expect-error absent specific fields cannot be indexed
issues.table.index('by_title', ['title'])
const invalidCommand: k.input<typeof tasks.tools.insert> = {
	title: 't',
	owner: k.id('users').parse('users:1'),
	// @ts-expect-error command fields exclude note
	note: 'n',
}
void invalidCommand

// A boundary with no fields accepts no keys, as v1's strict Zod object did (no command fields here).
const serverOwned = kTable('serverOwned', { secret: k.string() }, { serverFields: ['secret'] })
// @ts-expect-error command inputs do not contain server-owned fields
const emptyCommand: k.input<typeof serverOwned.commandInput> = { secret: 'x' }
const emptyCommandOk: k.input<typeof serverOwned.commandInput> = {}
void [emptyCommand, emptyCommandOk]
// @ts-expect-error reserved extension fields cannot be declared
serverOwned.dto({ extend: { _creationTime: k.number() } })
