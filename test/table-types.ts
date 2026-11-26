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
