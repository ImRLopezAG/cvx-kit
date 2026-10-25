import type { GenericSchema, SchemaDefinition, IndexRangeBuilder } from 'convex/server'
import { compareValues, type GenericId, type Value } from 'convex/values'
import type { RelationEdge, RelationGuard } from '../relations'
import type { createPlanner, QueryInput, StoredConstraint } from './planner'
import { scalarMatches } from './planner'
import type {
	FilterAst,
	FilterScalar,
	IndexCondition,
	NativePagination,
	QueryIndex,
} from './filters'
import { expansionForIndex, rangeForIndex, withinRange } from './filters'
import {
	executeStream,
	nativeIndexRange,
	rethrowQueryError,
	type ExecutionRequest,
} from './execution'
import type { createCursorCodec, CursorBinding } from './cursors'
import { CursorError } from './cursors'
import { z } from 'zod'
import { stream, EmptyStream, getIndexFields } from 'convex-helpers/server/stream'

export interface OutputSelection {
	[name: string]: true | OutputSelection
}
export type ResolvedGroups = {
	fieldGroups: Record<string, { mode: 'required' | 'if-permitted'; allowed: boolean }>
	relations: Record<string, ResolvedGroups>
}
export interface GroupAccess {
	at(path: readonly string[]): ResolvedGroups
	allowed(path: readonly string[]): readonly string[]
	checkOrder(table: string, fields: readonly string[], path?: readonly string[]): void
}
type Edge = RelationEdge<string, string, 'one' | 'many', any, any>
export type RelationDocument = Record<string, Value> & {
	_id: GenericId<string>
	_creationTime: number
}
type Document = RelationDocument
type Planner = ReturnType<typeof createPlanner>
const navigation = z.object({ cursor: z.string(), ancestors: z.array(z.string()).max(3) }).strict()

export class RelationshipError extends Error {
	constructor(readonly code: 'AMBIGUOUS_RELATION' | 'INVALID_RELATION') {
		super(code)
		this.name = 'RelationshipError'
	}
}

/** The selection has already passed the registry validator; count leaf edges too. */
export function assertRelationshipDepth(selection: OutputSelection, depth: number): void {
	for (const nested of Object.values(selection)) {
		if (depth >= 4) throw new RelationshipError('INVALID_RELATION')
		if (nested !== true) assertRelationshipDepth(nested, depth + 1)
	}
}

/** One request owns all traversal and authorized ID memoization. No raw reader escapes. */
export function relationshipExecutor(
	schema: SchemaDefinition<GenericSchema, boolean>,
	request: ExecutionRequest,
	planner: Planner,
	codec: ReturnType<typeof createCursorCodec>,
	rootBinding: CursorBinding,
	groups?: GroupAccess,
) {
	const metadata = planner.metadata
	const base = (leg: Edge['from']) => ('base' in leg ? leg.base : leg)
	function edge(table: string, name: string): Edge {
		const declared = metadata.declarations[table]?.[name]
		if (!declared) throw new RelationshipError('INVALID_RELATION')
		return declared
	}
	const guarded = (row: Document | Record<string, Value>, guard?: RelationGuard) =>
		!guard || row[guard.discriminator] === guard.tag
	const memberIdSchema = z.string()
	function memberMatches(value: Value | undefined, member: Edge['sourceMember']): boolean {
		if (!member) return true
		const id = memberIdSchema.safeParse(value)
		return id.success && request.db.normalizeId(member.table, id.data) !== null
	}
	function sourceValue(declared: Edge, parent: Document | null): Value | undefined {
		if (!parent || !guarded(parent, declared.sourceGuard)) return undefined
		const value = parent[base(declared.from).field]
		return memberMatches(value, declared.sourceMember) &&
			memberMatches(value, declared.targetMember)
			? value
			: undefined
	}
	function lookup(table: string, field: string, guard?: RelationGuard) {
		const index =
			field === '_id'
				? { name: 'by_id', fields: ['_id'] }
				: metadata.tables[table].indexes.find((i) => {
						const position = i.fields.indexOf(field)
						return (
							position >= 0 &&
							i.fields.slice(0, position).every((key) => key === guard?.discriminator)
						)
					})
		if (!index) throw new RelationshipError('INVALID_RELATION')
		return index
	}
	function checkTraversal(declared: Edge, path?: readonly string[]) {
		function check(
			table: string,
			field: string,
			guard?: RelationGuard,
			targetPath?: readonly string[],
		) {
			groups?.checkOrder(
				table,
				lookup(table, field, guard).fields.filter(
					(key) => key !== field && key !== guard?.discriminator,
				),
				targetPath,
			)
		}
		if ('base' in declared.from && 'base' in declared.to) {
			check(declared.from.junction.table, declared.from.junction.field, declared.junctionGuard)
			check(declared.target, declared.to.base.field, declared.targetGuard, path)
		} else check(declared.target, base(declared.to).field, declared.targetGuard, path)
	}
	function relationIndex(
		table: string,
		field: string,
		plan: ReturnType<Planner['plan']>,
		conditions: readonly IndexCondition[],
		guard?: RelationGuard,
	): QueryIndex {
		const indexes =
			field === '_id' ? [{ name: 'by_id', fields: ['_id'] }] : metadata.tables[table].indexes
		const bound = (key: string) =>
			key === field || key === guard?.discriminator || plan.bindings.has(key)
		const usable = (index: QueryIndex) =>
			index.fields.includes(field) &&
			index.fields.slice(0, index.fields.indexOf(field)).every(bound)
		const length = (index: QueryIndex) => {
			let size = 0
			for (const key of index.fields) {
				if (!bound(key)) break
				size++
			}
			return size
		}
		const condition = conditions.find((c) => c.value !== null && c.value !== undefined)
		if (condition) {
			const chosen = indexes.find((i) => i.name === condition.index && usable(i))
			if (!chosen)
				throw new Error(
					`Explicit index "${condition.index}" is incompatible with declared relationship lookup`,
				)
			return chosen
		}
		const candidates = indexes
			.filter(usable)
			.sort(
				(a, b) =>
					length(b) - length(a) ||
					Number(plan.sets.has(b.fields[length(b)])) - Number(plan.sets.has(a.fields[length(a)])) ||
					Number(plan.ranges.has(b.fields[length(b)])) -
						Number(plan.ranges.has(a.fields[length(a)])) ||
					a.name.localeCompare(b.name) ||
					a.fields.join('\0').localeCompare(b.fields.join('\0')),
			)
		if (!candidates.length) throw new RelationshipError('INVALID_RELATION')
		return candidates[0]
	}
	function relationPrefix(
		index: QueryIndex,
		field: string,
		value: FilterScalar,
		plan?: ReturnType<Planner['plan']>,
		guard?: RelationGuard,
	) {
		const prefix: { field: string; value: FilterScalar }[] = []
		for (const key of index.fields) {
			if (key === field) prefix.push({ field: key, value })
			else if (key === guard?.discriminator) prefix.push({ field: key, value: guard.tag })
			else if (plan?.bindings.has(key)) prefix.push({ field: key, value: plan.bindings.get(key)! })
			else break
		}
		return prefix
	}

	async function get(table: string, id: Value | undefined): Promise<Document | null> {
		planner.beforeLeaf(table)
		// SAFETY: native normalization rejects non-string/non-table IDs before any read.
		if (id == null || !request.db.normalizeId(table, id as string)) return null
		// SAFETY: normalizeId verifies the declared native table before the authorized metered get.
		const result = await request.db.get(table, id as GenericId<string>)
		if (result) planner.validateDocument(table, result)
		// SAFETY: normalizeId checked the table; the authorized native get retains system fields.
		return result as Document | null
	}
	async function* targets(
		table: string,
		field: string,
		value: Value | undefined,
		depth: number,
		guard?: RelationGuard,
		member?: Edge['targetMember'],
	): AsyncGenerator<Document> {
		request.expand(depth, 0)
		if (value == null || !memberMatches(value, member)) return
		if (field === '_id') {
			const target = await get(table, value)
			if (target && guarded(target, guard) && memberMatches(target[field], member)) {
				request.expand(depth)
				yield target
			}
			return
		}
		planner.beforeLeaf(table)
		const index = lookup(table, field, guard)
		// SAFETY: registry validates the indexed native lookup prefix and compatible values.
		const source = request.leafQuery(table).withIndex(index.name, (q) => {
			// SAFETY: registration checks the mandatory join and every preceding guard equality.
			let range = q as IndexRangeBuilder<any, string[], number>
			// SAFETY: registered relation fields are native scalars; each equality advances the consecutive checked prefix.
			for (const binding of relationPrefix(index, field, value as FilterScalar, undefined, guard)) {
				// SAFETY: the prefix comes from the declared index and registry-owned guard.
				range = range.eq(binding.field, binding.value) as IndexRangeBuilder<any, string[], number>
			}
			return range
		})
		const iterator = source[Symbol.asyncIterator]()
		try {
			while (true) {
				planner.beforeLeaf(table)
				const next = await iterator.next()
				if (next.done) return
				const permitted = await request.authorize(table, next.value)
				// Denials are an await boundary too; never hide them inside an authorized iterator.
				if (!permitted) continue
				planner.validateDocument(table, next.value)
				if (!guarded(next.value, guard) || !memberMatches(next.value[field], member)) continue
				request.expand(depth)
				// SAFETY: native rows include system fields and explicit authorization just completed.
				yield next.value as Document
			}
		} finally {
			await iterator.return?.()
		}
	}
	async function* traverse(
		declared: Edge,
		parent: Document,
		depth: number,
	): AsyncGenerator<Document> {
		request.expand(depth, 0)
		const value = sourceValue(declared, parent)
		if (value == null) return
		if ('base' in declared.from && 'base' in declared.to) {
			for await (const junction of targets(
				declared.from.junction.table,
				declared.from.junction.field,
				value,
				depth,
				declared.junctionGuard,
			))
				yield* targets(
					declared.target,
					declared.to.base.field,
					junction[declared.to.junction.field],
					depth,
					declared.targetGuard,
				)
		} else
			yield* targets(
				declared.target,
				base(declared.to).field,
				value,
				depth,
				declared.targetGuard,
				declared.targetMember,
			)
	}
	async function one(declared: Edge, parent: Document, depth: number) {
		let match: Document | null = null
		for await (const target of traverse(declared, parent, depth)) {
			if (match) throw new RelationshipError('AMBIGUOUS_RELATION')
			match = target
		}
		return match
	}
	async function matches(
		table: string,
		parent: Document,
		ast: FilterAst,
		depth = 0,
	): Promise<boolean> {
		request.expand(depth, 0)
		// Variant rows must satisfy the captured stored branch before predicates
		// inspect branch fields. Ordinary output rows are validated by projection.
		if (metadata.tables[table].variant) planner.validateDocument(table, parent)
		if (scalarOnly(ast)) return scalarMatches(ast, parent)
		if (ast.kind === 'variant')
			return parent[ast.discriminator] === ast.tag && matches(table, parent, ast.child, depth)
		if (ast.kind === 'scalar') return scalarMatches(ast, parent)
		if (ast.kind === 'not') return !(await matches(table, parent, ast.child, depth))
		if (ast.kind === 'and' || ast.kind === 'or') {
			for (const child of ast.children) {
				const result = await matches(table, parent, child, depth)
				if (ast.kind === 'and' && !result) return false
				if (ast.kind === 'or' && result) return true
			}
			return ast.kind === 'and'
		}
		if (ast.kind !== 'relation') throw new RelationshipError('INVALID_RELATION')
		const declared = edge(table, ast.name)
		if (ast.mode === 'one') {
			const target = await one(declared, parent, depth + 1)
			return ast.predicate === null
				? target === null
				: target !== null && (await matches(declared.target, target, ast.predicate, depth + 1))
		}
		for await (const target of traverse(declared, parent, depth + 1))
			if (await matches(declared.target, target, ast.predicate!, depth + 1))
				return ast.mode === 'some'
		// Only actual authorized traversal exhaustion proves none.
		return ast.mode === 'none'
	}
	async function output(
		table: string,
		parent: Document,
		selection: OutputSelection,
		args: NativePagination & { order?: 'asc' | 'desc' },
		path: readonly string[] = [],
		depth = 0,
		parents: readonly string[] = [],
	): Promise<Record<string, Value>> {
		request.expand(depth, 0)
		// SAFETY: the registry strictly validates this public native DTO projection.
		const dto = planner.complete(
			table,
			parent,
			true,
			{ kind: 'and', children: [] },
			groups?.allowed(path),
		) as Record<string, Value>
		for (const [name, selected] of Object.entries(selection)) {
			const declared = edge(table, name),
				nested = selected === true ? {} : selected
			if (declared.cardinality === 'one') {
				const target = await one(declared, parent, depth + 1)
				dto[name] = target
					? await output(declared.target, target, nested, args, [...path, name], depth + 1, [
							...parents,
							parent._id,
						])
					: null
			} else {
				const page = await pageRelation(
					table,
					parent,
					name,
					nested,
					{ numItems: args.numItems, cursor: null, order: args.order },
					[],
					[],
					[...path, name],
					depth + 1,
					[...parents, parent._id],
				)
				// SAFETY: pageRelation projects and validates each nested DTO row.
				dto[name] = page as Value
			}
		}
		return dto
	}
	function prepare(
		table: string,
		name: string,
		selection: OutputSelection,
		input: QueryInput,
		conditions: readonly IndexCondition[],
		constraints: readonly StoredConstraint[],
		path: readonly string[],
		rootId: string,
		ordering?: string,
	) {
		if (ordering !== undefined && conditions.some((c) => c.value !== null && c.value !== undefined))
			throw new Error('orderBy cannot be combined with an active when selector')
		planner.select(edge(table, name).target, selection)
		assertRelationshipDepth(selection, path.length)
		const declared = edge(table, name)
		if (declared.cardinality !== 'many') throw new RelationshipError('INVALID_RELATION')
		const guardConstraint = declared.targetGuard
			? { fields: { [declared.targetGuard.discriminator]: declared.targetGuard.tag } }
			: undefined
		const plan = planner.plan(
			declared.target,
			input,
			[],
			guardConstraint ? [...constraints, guardConstraint] : constraints,
			ordering,
			'relation',
		)
		const from = declared.from,
			to = declared.to
		const through =
			'base' in from && 'base' in to
				? {
						table: from.junction.table,
						field: from.junction.field,
						targetField: to.base.field,
						targetReference: to.junction.field,
					}
				: null
		if (ordering !== undefined && through)
			throw new Error('orderBy is unsupported for junction relationships')
		const sourceTable = through ? through.table : declared.target
		const field = through ? through.field : base(to).field
		const targetIndex = relationIndex(
			declared.target,
			through ? through.targetField : field,
			plan,
			ordering === undefined ? conditions : [{ value: true, index: ordering }],
			declared.targetGuard,
		)
		groups?.checkOrder(
			declared.target,
			targetIndex.fields.filter(
				(key) =>
					key !== (through ? through.targetField : field) &&
					key !== declared.targetGuard?.discriminator &&
					!plan.bindings.has(key),
			),
			path,
		)
		const index = through ? lookup(sourceTable, field, declared.junctionGuard) : targetIndex
		if (through)
			groups?.checkOrder(
				sourceTable,
				index.fields.filter(
					(key) => key !== field && key !== declared.junctionGuard?.discriminator,
				),
			)
		// The lookup value changes only values, not prefix positions or comparator.
		const expansion =
			through || plan.unsatisfiable
				? null
				: expansionForIndex(
						index,
						relationPrefix(index, field, null, plan, declared.targetGuard),
						plan.sets,
						ordering !== undefined ||
							conditions.some((c) => c.value !== null && c.value !== undefined),
					)
		const groupBinding: Record<string, Value> = {}
		const resolved = groups?.at(path)
		if (
			resolved &&
			(Object.keys(resolved.fieldGroups).length || Object.keys(resolved.relations).length)
		)
			groupBinding.fieldGroups = resolved
		// SAFETY: planner.page validated the complete output mask before cursor binding.
		const binding: CursorBinding = {
			...rootBinding,
			table: sourceTable,
			index: index.name,
			order: plan.args.order ?? 'asc',
			clientFilters: plan.clientIdentity,
			serverFilters: {
				predicates: plan.sets.size
					? {
							predicates: plan.serverIdentity,
							traversal: { version: 2, expansion: expansion ? { ...expansion } : null },
						}
					: plan.serverIdentity,
				selection: selection as Value,
				...groupBinding,
				scope: { ...request.scope },
				rootTable: rootBinding.table,
				lookupIndex: targetIndex.name,
				guards: {
					source: declared.sourceGuard ? { ...declared.sourceGuard } : null,
					target: declared.targetGuard ? { ...declared.targetGuard } : null,
					junction: declared.junctionGuard ? { ...declared.junctionGuard } : null,
				},
				...((declared.sourceMember || declared.targetMember) && {
					members: {
						source: declared.sourceMember ? { ...declared.sourceMember } : null,
						target: declared.targetMember ? { ...declared.targetMember } : null,
					},
				}),
			},
			relationPath: path,
			parent: rootId,
		}
		function open(token: string) {
			try {
				return navigation.parse(JSON.parse(codec.open(token, binding)))
			} catch {
				throw new CursorError()
			}
		}
		return {
			declared,
			plan,
			through,
			sourceTable,
			field,
			index,
			targetIndex,
			binding,
			open,
			expansion,
		}
	}
	async function pageRelation(
		table: string,
		parent: Document | null,
		name: string,
		selection: OutputSelection,
		input: QueryInput,
		conditions: readonly IndexCondition[] = [],
		constraints: readonly StoredConstraint[] = [],
		path: readonly string[] = [name],
		depth = 1,
		parents: readonly string[] = [],
		prepared = prepare(
			table,
			name,
			selection,
			input,
			conditions,
			constraints,
			path,
			parents[0] ?? parent!._id,
		),
		opened?: { cursor: string | null; endCursor?: string | null },
	) {
		request.expand(depth, 0)
		const { declared, plan, through, sourceTable, field, index, targetIndex, binding, expansion } =
			prepared
		const value = sourceValue(declared, parent)
		const args = { ...plan.args, ...(opened ?? { cursor: null }) }
		// SAFETY: declarations accept only native scalar lookup values; nullish references are absence.
		const lookupPlan = {
			...plan,
			expansion,
			index,
			prefix:
				value == null
					? []
					: through
						? relationPrefix(index, field, value as FilterScalar, undefined, declared.junctionGuard)
						: relationPrefix(index, field, value as FilterScalar, plan, declared.targetGuard),
			unsatisfiable: value == null || plan.unsatisfiable,
		}
		lookupPlan.range = through ? null : rangeForIndex(index, lookupPlan.prefix, plan.ranges)
		if (!through)
			for (const binding of lookupPlan.prefix) {
				const range = plan.ranges.get(binding.field)
				if (
					plan.bindings.has(binding.field) &&
					compareValues(binding.value, plan.bindings.get(binding.field)!) !== 0
				)
					lookupPlan.unsatisfiable = true
				if (range && !withinRange(binding.value, range)) lookupPlan.unsatisfiable = true
			}
		const indexedTarget = through && through.targetField !== '_id'
		const result = await executeStream(
			schema,
			request,
			sourceTable,
			lookupPlan,
			planner,
			codec,
			binding,
			args,
			async (row, permitted) => {
				if (permitted) planner.validateDocument(indexedTarget ? declared.target : sourceTable, row)
				if (!permitted || (through && !indexedTarget && !guarded(row, declared.junctionGuard)))
					return null
				request.expand(depth)
				let target: Document | null
				if (through && !indexedTarget)
					target = await get(declared.target, row[through.targetReference])
				else {
					// SAFETY: native direct/flattened target streams retain validated system fields.
					target = row as Document
				}
				if (
					!target ||
					!guarded(target, declared.targetGuard) ||
					!memberMatches(target[base(declared.to).field], declared.targetMember) ||
					!(await matches(declared.target, target, plan.residual, depth))
				)
					return null
				return output(declared.target, target, selection, plan.args, path, depth, parents)
			},
			(raw) => codec.seal(JSON.stringify({ cursor: raw, ancestors: parents.slice(1) }), binding),
			indexedTarget
				? (source, db) => {
						// SAFETY: the registry owns the native schema/index descriptors. Public
						// helper flatMap concatenates native outer/inner keys and paginates them.
						const nativeSchema = schema as SchemaDefinition<
							Record<
								string,
								import('convex/server').TableDefinition<any, Record<string, string[]>>
							>,
							boolean
						>
						const fields = getIndexFields(declared.target, targetIndex.name, nativeSchema)
						return source.flatMap(async (junction) => {
							request.expand(depth)
							const permitted = await request.authorize(sourceTable, junction)
							if (permitted) planner.validateDocument(sourceTable, junction)
							const reference = junction[through.targetReference]
							if (!permitted || !guarded(junction, declared.junctionGuard) || reference == null)
								return new EmptyStream(plan.args.order ?? 'asc', fields)
							return stream(db, nativeSchema)
								.query(declared.target)
								.withIndex(targetIndex.name, (q) => {
									// SAFETY: registry-owned lookup bindings are native scalar index values.
									const prefix = relationPrefix(
										targetIndex,
										through.targetField,
										reference as FilterScalar,
										plan,
										declared.targetGuard,
									)
									return nativeIndexRange(
										q,
										prefix,
										rangeForIndex(targetIndex, prefix, plan.ranges),
									)
								})
								.order(plan.args.order ?? 'asc')
						}, fields)
					}
				: undefined,
			indexedTarget ? declared.target : sourceTable,
		)
		return result
	}
	async function continuation(
		rootTable: string,
		rootId: string,
		path: readonly string[],
		selection: OutputSelection,
		input: QueryInput,
		conditions: readonly IndexCondition[],
		constraints: readonly StoredConstraint[],
		ordering?: string,
	) {
		if (!path.length || path.length > 4 || !request.db.normalizeId(rootTable, rootId))
			throw new RelationshipError('INVALID_RELATION')
		let table = rootTable
		const declarations = path.map((name) => {
			const declaration = edge(table, name)
			table = declaration.target
			return declaration
		})
		if (ordering !== undefined && declarations.some((d) => 'base' in d.from || 'base' in d.to))
			throw new Error('orderBy is unsupported for junction relationships')
		const final = declarations.at(-1)!
		for (const declaration of declarations.slice(0, -1))
			if (
				declaration.cardinality === 'one' ||
				'base' in declaration.from ||
				'base' in declaration.to
			)
				checkTraversal(declaration)
		const prepared = prepare(
			final.source,
			path.at(-1)!,
			selection,
			input,
			conditions,
			constraints,
			path,
			rootId,
			ordering,
		)
		// Authenticate both slots and native ancestor IDs before ANY parent/traversal read.
		const start = input.cursor === null ? null : prepared.open(input.cursor)
		const end = input.endCursor == null ? null : prepared.open(input.endCursor)
		const ancestors = start?.ancestors ?? end?.ancestors ?? []
		if (
			ancestors.length !== path.length - 1 ||
			(start && end && JSON.stringify(start.ancestors) !== JSON.stringify(end.ancestors)) ||
			ancestors.some((id, i) => !request.db.normalizeId(declarations[i].target, id))
		)
			throw new CursorError()
		// Declarative input/index/cursor validation above retains its pre-read errors,
		// just as on the root path. Every awaited read, ancestry proof and page is protected.
		try {
			let parent = await get(rootTable, rootId)
			for (let i = 0; parent && i < ancestors.length; i++) {
				const declared = declarations[i]
				let found: Document | null = null
				if (
					declared.cardinality === 'many' &&
					!('base' in declared.from) &&
					!('base' in declared.to)
				) {
					// A cursor names this ancestor. Prove its current authorized membership
					// by ID instead of replaying an ordering that is not part of this page.
					request.expand(i + 1, 0)
					const value = sourceValue(declared, parent)
					const target = value == null ? null : await get(declared.target, ancestors[i])
					const key = declared.to.field
					if (
						value != null &&
						target &&
						guarded(target, declared.targetGuard) &&
						memberMatches(target[key], declared.targetMember) &&
						target[key] !== undefined &&
						compareValues(value, target[key]) === 0
					) {
						request.expand(i + 1)
						found = target
					}
				} else if (declared.cardinality === 'one') {
					const target = await one(declared, parent, i + 1)
					if (target?._id === ancestors[i]) found = target
				} else
					for await (const target of traverse(declared, parent, i + 1)) {
						if (target._id === ancestors[i]) {
							found = target
							break
						}
					}
				parent = found
			}
			return await pageRelation(
				final.source,
				parent,
				path.at(-1)!,
				selection,
				input,
				conditions,
				constraints,
				path,
				path.length,
				[rootId, ...ancestors],
				prepared,
				{ cursor: start?.cursor ?? null, endCursor: end?.cursor ?? input.endCursor },
			)
		} catch (error) {
			rethrowQueryError(error)
		}
	}
	/** Admit the complete output tree even when a parent query produces no rows. */
	function preflight(
		table: string,
		selection: OutputSelection,
		input: QueryInput,
		path: readonly string[] = [],
	) {
		for (const [name, selected] of Object.entries(selection)) {
			const declared = edge(table, name)
			const nested = selected === true ? {} : selected
			const nestedPath = [...path, name]
			if (declared.cardinality === 'many')
				prepare(
					table,
					name,
					nested,
					{ numItems: input.numItems, cursor: null, order: input.order },
					[],
					[],
					nestedPath,
					'',
				)
			else checkTraversal(declared, nestedPath)
			preflight(declared.target, nested, input, nestedPath)
		}
	}
	return { matches, output, continuation, edge, preflight }
}

function scalarOnly(ast: FilterAst): boolean {
	if (ast.kind === 'relation') return false
	if (ast.kind === 'and' || ast.kind === 'or') return ast.children.every(scalarOnly)
	if (ast.kind === 'not' || ast.kind === 'variant') return scalarOnly(ast.child)
	return true
}
