import type { TableDefinition } from 'convex/server'

/**
 * Merges per-module table maps into the application schema map, rejecting
 * duplicate table names across modules — the module-registry combinator for
 * domain/table.ts: `defineSchema(createModule(catalogTables, salesTables))`.
 * Accepts plain maps and `namespace(...)` maps side by side; namespaces add
 * no keys, so the result is the same flat `{ tableName: TableDefinition }`.
 */
export function createModule<const Maps extends readonly Record<string, TableDefinition<any>>[]>(
	...maps: Maps
): FlatTables<UnionToIntersection<Maps[number]>> {
	const combined: Record<string, TableDefinition<any>> = {}
	const namespaceNames = new Set<string>()
	for (const map of maps) {
		const meta = namespaceMeta(map)
		if (meta) {
			if (namespaceNames.has(meta.name)) {
				throw new Error(`Namespace "${meta.name}" is declared more than once`)
			}
			namespaceNames.add(meta.name)
		}
		for (const [tableName, definition] of Object.entries(map)) {
			if (tableName in combined) {
				throw new Error(`Table "${tableName}" is declared by more than one module`)
			}
			combined[tableName] = definition
		}
	}
	// SAFETY: every string-keyed input entry is copied, and duplicate keys are rejected above.
	return combined as FlatTables<UnionToIntersection<Maps[number]>>
}

type FlatTables<Map> = { [Key in keyof Map as Key extends string ? Key : never]: Map[Key] }

const namespaceKey: unique symbol = Symbol.for('cvx-kit/zod-table/namespace')

/** Declaration-level metadata carried by a `namespace(...)` table map. */
export type NamespaceInfo<Name extends string, Tables extends string> = {
	readonly name: Name
	readonly tables: readonly Tables[]
}

/**
 * A table map tagged with a namespace. It is still a plain
 * `{ tableName: TableDefinition }` map (the tag is a non-enumerable symbol),
 * so `createModule`/`defineSchema` see exactly the tables they saw before.
 */
export type Namespace<
	Name extends string,
	Tables extends Record<string, TableDefinition<any>>,
> = Tables & NamespaceTag<Name, keyof Tables & string>

/** The metadata-only shape of a `namespace(...)` map. */
export type NamespaceTag<Name extends string, Tables extends string> = {
	readonly [namespaceKey]: NamespaceInfo<Name, Tables>
}

type DotsToUnderscores<Name extends string> = Name extends `${infer Head}.${infer Tail}`
	? `${Head}_${DotsToUnderscores<Tail>}`
	: Name

/** Stored-table prefix of a namespace: `Microsoft.Inventory` → `Microsoft_Inventory_`. */
export type NamespacePrefix<Name extends string> = `${DotsToUnderscores<Name>}_`

/**
 * Member name of a table. A table stored with its namespace prefix drops it
 * (`Inventory_Items` in `Inventory` → `Items`); any other table name is
 * PascalCased (`itemLedgerEntries` → `ItemLedgerEntries`).
 */
export type MemberName<TableName extends string, Name extends string = never> = [Name] extends [
	never,
]
	? Capitalize<TableName>
	: TableName extends `${NamespacePrefix<Name>}${infer Rest extends string}`
		? Rest extends ''
			? Capitalize<TableName>
			: Rest
		: Capitalize<TableName>

/** Fully qualified name: `<Namespace>.<Member>`, e.g. `Inventory.Items`. */
export type QualifiedName<
	Name extends string,
	TableName extends string,
> = `${Name}.${MemberName<TableName, Name>}`

/** Options for `namespace(...)`. */
export type NamespaceOptions<Prefixed extends boolean = boolean> = {
	/** Require every key to start with the namespace prefix (`Inventory_`). */
	prefixed?: Prefixed
}

type NamespaceMember = TableDefinition<any> | { tableName: string; table: TableDefinition<any> }
type MemberTables<Members extends Record<string, NamespaceMember>> = {
	[Key in keyof Members]: Members[Key] extends { table: infer Table extends TableDefinition<any> }
		? Table
		: Extract<Members[Key], TableDefinition<any>>
}
type CheckedMembers<
	Members extends Record<string, NamespaceMember>,
	Name extends string,
	Prefixed extends boolean,
> = {
	[Key in keyof Members]: Prefixed extends true
		? Key extends `${NamespacePrefix<Name>}${infer Rest}`
			? Rest extends ''
				? never
				: CheckedMember<Members[Key], Key>
			: never
		: CheckedMember<Members[Key], Key>
}
type CheckedMember<Member, Key> = Member extends { tableName: infer TableName }
	? TableName extends Key
		? Member
		: { tableName: Key; table: TableDefinition<any> }
	: Member
type CheckedNamespaceName<Name extends string> = Name extends ''
	? never
	: Name extends `${string}..${string}` | `.${string}` | `${string}.`
		? never
		: Name

const NAMESPACE_SEGMENT = /^[A-Za-z][A-Za-z0-9]*$/
// Convex table names: letters, digits and underscores, not starting with an underscore.
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Groups tables under a declaration-level namespace, like AL's
 * `namespace Microsoft.Inventory.Item;`. Keys are the real (stored) table
 * names, exactly as in an un-namespaced module map. A key stored with the
 * namespace prefix (`Inventory_Items`, or `Microsoft_Inventory_Items` for
 * `Microsoft.Inventory`) has the remainder as its member name (`Items`);
 * any other key is PascalCased (`items` → `Items`). The qualified name is
 * `<Namespace>.<Member>` (`Inventory.Items`). Storage, ids, queries and
 * generated types are unchanged.
 *
 * `{ prefixed: true }` requires every key to carry the prefix: a key
 * without it is a type error and a runtime error.
 *
 * A member may be a `TableDefinition` (`items.table.index(...)`) or a table
 * boundary (`items`); a boundary whose `tableName` differs from its key is a
 * type error and a runtime error. Dotted names (`Microsoft.Inventory`) are
 * allowed; each segment is an identifier (`Microsoft.Inventory`, `sales`).
 */
export function namespace<
	const Name extends string,
	const Members extends Record<string, NamespaceMember>,
	const Prefixed extends boolean = false,
>(
	name: Name & CheckedNamespaceName<Name>,
	members: Members & CheckedMembers<Members, Name, Prefixed>,
	options: NamespaceOptions<Prefixed> = {},
): Namespace<Name, MemberTables<Members>> {
	if (!name.split('.').every((segment) => NAMESPACE_SEGMENT.test(segment))) {
		throw new Error(
			`Namespace "${name}" must be dot-separated identifiers (e.g. "Microsoft.Inventory" or "sales")`,
		)
	}
	const tables: Record<string, TableDefinition<any>> = {}
	// SAFETY: CheckedMembers only narrows member types; every member is still a NamespaceMember.
	for (const [key, member] of Object.entries(members as Record<string, NamespaceMember>)) {
		if (!TABLE_NAME.test(key)) {
			throw new Error(
				`Namespace "${name}" member "${key}" must be a table name (letters, digits and underscores)`,
			)
		}
		if (options.prefixed && !hasPrefix(key, name)) {
			throw new Error(
				`Namespace "${name}" member "${key}" must start with "${namespacePrefix(name)}"`,
			)
		}
		if ('tableName' in member) {
			if (member.tableName !== key) {
				throw new Error(
					`Namespace "${name}" member "${key}" holds table "${member.tableName}"; keys must be the table name`,
				)
			}
			tables[key] = member.table
		} else {
			tables[key] = member
		}
	}
	Object.defineProperty(tables, namespaceKey, {
		value: Object.freeze({ name, tables: Object.freeze(Object.keys(tables)) }),
		enumerable: false,
	})
	// SAFETY: tables holds one TableDefinition per member key plus the symbol tag.
	return tables as Namespace<Name, MemberTables<Members>>
}

/** Stored-table prefix of a namespace: `Microsoft.Inventory` → `Microsoft_Inventory_`. */
export function namespacePrefix<const Name extends string>(name: Name) {
	// SAFETY: replacing every dot with an underscore and appending one is what NamespacePrefix computes.
	return `${name.replaceAll('.', '_')}_` as NamespacePrefix<Name>
}

/**
 * Member name of a table name: without the namespace prefix when given and
 * present (`memberName('Inventory_Items', 'Inventory')` → `Items`), else PascalCased.
 */
export function memberName<const TableName extends string, const Name extends string = never>(
	tableName: TableName,
	namespaceName?: Name,
) {
	const name =
		namespaceName !== undefined && hasPrefix(tableName, namespaceName)
			? tableName.slice(namespacePrefix(namespaceName).length)
			: tableName.charAt(0).toUpperCase() + tableName.slice(1)
	// SAFETY: the prefix is stripped or the name capitalised exactly as MemberName computes.
	return name as MemberName<TableName, Name>
}

/** The namespace name of a `namespace(...)` map. */
export function namespaceName<const Name extends string>(ns: NamespaceTag<Name, string>): Name {
	// SAFETY: a NamespaceTag is only produced by namespace(...), which records its Name in the tag.
	return namespaceMeta(ns)!.name as Name
}

/** The stored table names declared in a namespace, in declaration order. */
export function tablesOf<const Tables extends string>(
	ns: NamespaceTag<string, Tables>,
): readonly Tables[] {
	// SAFETY: a NamespaceTag is only produced by namespace(...), which records its member keys in the tag.
	return namespaceMeta(ns)!.tables as readonly Tables[]
}

type NamespaceEntries<Spaces extends readonly NamespaceTag<string, string>[]> = {
	[Index in keyof Spaces]: Spaces[Index] extends NamespaceTag<infer Name, infer Tables>
		? { [TableName in Tables]: Name }
		: never
}[number]
type TableNamespaceMap<Spaces extends readonly NamespaceTag<string, string>[]> =
	UnionToIntersection<NamespaceEntries<Spaces>>

/**
 * Typed, read-only qualified-name lookup over namespaces (no global registry:
 * build one next to `createModule` and import it where labels are needed).
 * Rejects duplicate namespace names and tables claimed by two namespaces.
 */
export function namespaceIndex<const Spaces extends readonly NamespaceTag<string, string>[]>(
	...spaces: Spaces
) {
	type Map = TableNamespaceMap<Spaces>
	type TableName = keyof Map & string
	type NameOf = Spaces[number] extends NamespaceTag<infer Name, string> ? Name : never
	const byTable = new Map<string, string>()
	const byName = new Map<string, readonly string[]>()
	for (const space of spaces) {
		const meta = namespaceMeta(space)
		if (!meta) throw new Error('namespaceIndex accepts only namespace(...) maps')
		if (byName.has(meta.name)) {
			throw new Error(`Namespace "${meta.name}" is declared more than once`)
		}
		byName.set(meta.name, meta.tables)
		for (const table of meta.tables) {
			const owner = byTable.get(table)
			if (owner) {
				throw new Error(`Table "${table}" is declared by namespaces "${owner}" and "${meta.name}"`)
			}
			byTable.set(table, meta.name)
		}
	}
	const owner = (table: string) => {
		const name = byTable.get(table)
		if (name === undefined) throw new Error(`Table "${table}" is not in a namespace`)
		return name
	}
	return {
		qualifiedName<const Table extends TableName>(table: Table) {
			const name = owner(table)
			// SAFETY: owner returns the namespace that declared this table, as Map records.
			return `${name}.${memberName(table, name)}` as {
				[Key in Table]: QualifiedName<Map[Key] & string, Key>
			}[Table]
		},
		namespaceOf<const Table extends TableName>(table: Table) {
			// SAFETY: owner returns the namespace that declared this table, as Map records.
			return owner(table) as Map[Table]
		},
		memberName,
		tablesOf<const Name extends NameOf>(name: Name) {
			const tables = byName.get(name)
			if (!tables) throw new Error(`Namespace "${name}" is not indexed`)
			// SAFETY: byName records exactly the tables of each indexed namespace.
			return tables as readonly {
				[Table in TableName]: Map[Table] extends Name ? Table : never
			}[TableName][]
		},
		namespaces: indexedNames<NameOf>(byName),
		has(table: string): table is TableName {
			return byTable.has(table)
		},
	}
}

type UnionToIntersection<Union> = (
	Union extends unknown ? (member: Union) => void : never
) extends (member: infer Intersection) => void
	? Intersection
	: never

/** A table map as `createModule` and `namespaceIndex` receive it; a namespace adds a symbol tag. */
type TableMap = Record<string, TableDefinition<any>> | NamespaceTag<string, string>

function namespaceMeta(map: TableMap): NamespaceInfo<string, string> | undefined {
	// SAFETY: the tag is either absent or the frozen NamespaceInfo that namespace(...) defined.
	return (map as { [namespaceKey]?: NamespaceInfo<string, string> })[namespaceKey]
}

function hasPrefix(tableName: string, name: string) {
	const prefix = namespacePrefix(name)
	return tableName.startsWith(prefix) && tableName.length > prefix.length
}

function indexedNames<Name extends string>(byName: ReadonlyMap<string, readonly string[]>) {
	const names: Name[] = []
	for (const name of byName.keys()) {
		// SAFETY: namespaceIndex keys byName by the names of the namespaces it indexed, which Name lists.
		names.push(name as Name)
	}
	return names
}
