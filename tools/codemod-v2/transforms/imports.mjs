// Imports: resolves what `z` and the kit names are bound to, then plans the
// import edits once every unit's fate is known (add `k`, drop Zod when unused).
// Kit entry imports are always rewritten, whatever happens to the file's Zod:
// `cvx-kit/zod-table` names move to `cvx-kit/table`, convex-helpers' Zod
// function builders move to `cvx-kit/registration`, renamed kit helpers take
// their v2 name, and a moved name joins an existing import of its new module.

export const ZOD_MODULES = new Set(['zod', 'zod/v4', 'zod/v3'])
const TABLE_MODULE = 'cvx-kit/zod-table'
const NEXT_TABLE_MODULE = 'cvx-kit/table'
const ZID_MODULES = new Set(['convex-helpers/server/zod4', 'convex-helpers/server/zod'])
const REGISTRATION_MODULE = 'cvx-kit/registration'
/** convex-helpers' Zod function builders, which take `k` args only once renamed. */
const CUSTOM_BUILDERS = new Map([
	['zCustomQuery', 'kCustomQuery'],
	['zCustomMutation', 'kCustomMutation'],
	['zCustomAction', 'kCustomAction'],
	['ZCustomCtx', 'KCustomCtx'],
])
/** Modules whose `k` import is the kit's `k`. */
const K_MODULES = new Set(['cvx-kit', 'cvx-kit/k'])
/** v2 table functions; a binding initialised by one is a table boundary. */
export const V2_TABLE_FUNCTIONS = new Set(['kTable', 'kVariantTable', 'tenantTable'])
const V2_TABLE_MODULES = new Set(['cvx-kit', 'cvx-kit/table'])
const KIT_MODULE_NAMES = new Map([
	[
		'cvx-kit',
		new Set([
			'zodTable',
			'zodVariantTable',
			'createTable',
			'tenantTable',
			'paginated',
			'jsonSafeZid',
		]),
	],
	['cvx-kit/contracts', new Set(['zodContract'])],
	['cvx-kit/effect', new Set(['effectZodApiBuilder'])],
])

export const KIT_RENAMES = new Map([
	['zodTable', 'kTable'],
	['zodVariantTable', 'kVariantTable'],
	['zodContract', 'kContract'],
	['effectZodApiBuilder', 'effectApiBuilder'],
	...CUSTOM_BUILDERS,
])

/** The module a kit binding's v2 name is imported from, when it moves. */
function movedModule(binding) {
	if (binding.module === TABLE_MODULE) return NEXT_TABLE_MODULE
	if (ZID_MODULES.has(binding.module) && CUSTOM_BUILDERS.has(binding.imported))
		return REGISTRATION_MODULE
	return null
}

/** Whether a kit binding is always rewritten to its v2 form, in every unit. */
export function alwaysRewritten(binding) {
	return (
		!ZOD_INTEROP.has(binding.imported) &&
		binding.imported !== 'zid' &&
		(KIT_RENAMES.has(binding.imported) || movedModule(binding) !== null)
	)
}

export const ZOD_INTEROP = new Set(['zodToConvex', 'convexToZod', 'jsonSafeZid'])

function importedName(spec) {
	return spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value
}

export function collectImports(ctx) {
	for (const decl of ctx.program.body) {
		if (decl.type !== 'ImportDeclaration') continue
		const module = decl.source.value
		if (ZOD_MODULES.has(module)) {
			ctx.zodDecls.push(decl)
			for (const spec of decl.specifiers) {
				const local = spec.local.name
				if (spec.type !== 'ImportSpecifier' || importedName(spec) === 'z')
					ctx.zodNamespaces.add(local)
				else ctx.zodNamed.add(local)
			}
			continue
		}
		collectKitImport(ctx, decl, module)
	}
}

function collectKitImport(ctx, decl, module) {
	const names = KIT_MODULE_NAMES.get(module)
	const tracked = module === TABLE_MODULE || ZID_MODULES.has(module) || names !== undefined
	for (const spec of decl.specifiers) {
		const local = spec.local.name
		if (local === 'k') {
			if (K_MODULES.has(module) && spec.type === 'ImportSpecifier' && importedName(spec) === 'k') {
				ctx.hasK = true
			} else ctx.kConflict = spec
		}
		if (
			V2_TABLE_MODULES.has(module) &&
			spec.type === 'ImportSpecifier' &&
			V2_TABLE_FUNCTIONS.has(importedName(spec))
		)
			ctx.v2Tables.add(local)
		if (spec.type === 'ImportSpecifier' && !ZOD_MODULES.has(module))
			ctx.imported.set(local, { source: module, imported: importedName(spec) })
	}
	if (decl.importKind !== 'type' && decl.specifiers.length > 0 && decl.specifiers.every(isNamed))
		ctx.moduleDecls.set(module, ctx.moduleDecls.get(module) ?? decl)
	if (module === 'cvx-kit' && decl.importKind !== 'type' && decl.specifiers.every(isNamed)) {
		ctx.kitRootDecl ??= decl
	}
	if (!tracked || !decl.specifiers.every(isNamed)) return
	for (const spec of decl.specifiers) {
		const imported = importedName(spec)
		const wanted =
			module === TABLE_MODULE ||
			(ZID_MODULES.has(module) && (imported === 'zid' || CUSTOM_BUILDERS.has(imported))) ||
			names?.has(imported) === true
		if (!wanted) continue
		ctx.kit.set(spec.local.name, {
			local: spec.local.name,
			imported,
			module,
			decl,
			spec,
			isType: spec.importKind === 'type' || decl.importKind === 'type',
			refs: [],
		})
	}
}

function isNamed(spec) {
	return spec.type === 'ImportSpecifier'
}

/** Import edits for the file once `isLeft(unitIndex)` is final. */
export function planImports(ctx, isLeft, needsK) {
	const edits = []
	let anchor = null
	let zodRemains = false
	let oldKitRemains = false
	for (const decl of ctx.zodDecls) {
		const keep = decl.specifiers.filter((spec) =>
			(ctx.zodRefs.get(spec.local.name) ?? []).some(isLeft),
		)
		if (
			keep.length === decl.specifiers.length ||
			(keep.length > 0 && !decl.specifiers.every(isNamed))
		) {
			zodRemains = true
			continue
		}
		if (keep.length === 0) {
			const edit = removal(ctx, decl)
			edits.push(edit)
			anchor ??= edit
			continue
		}
		zodRemains = true
		const specs = keep.map((spec) =>
			specOf(importedName(spec), spec.local.name, spec.importKind === 'type'),
		)
		edits.push(replacement(ctx, decl, [renderSource(ctx, decl, specs)]))
	}
	const byDecl = new Map()
	for (const binding of ctx.kit.values()) {
		if (!byDecl.has(binding.decl)) byDecl.set(binding.decl, [])
		byDecl.get(binding.decl).push(binding)
	}
	let addK = needsK && !ctx.hasK
	const planned = []
	const movedBy = new Map()
	for (const [decl, bindings] of byDecl) {
		const withK = addK && decl === ctx.kitRootDecl
		const plan = planKitDecl(ctx, decl, bindings, isLeft, withK)
		if (!plan) continue
		if (withK) addK = false
		oldKitRemains ||= plan.oldRemains
		planned.push({ decl, plan })
		for (const [module, specs] of plan.moved) {
			if (!movedBy.has(module)) movedBy.set(module, { origin: decl, specs: [] })
			movedBy.get(module).specs.push(...specs)
		}
	}
	const linesOf = new Map(planned.map(({ decl, plan }) => [decl, [...plan.lines]]))
	for (const [module, { origin, specs }] of movedBy) {
		const existing = ctx.moduleDecls.get(module)
		const present = new Set(existing?.specifiers.map((spec) => spec.local.name) ?? [])
		const unique = specs.filter((spec) => {
			if (present.has(spec.local)) return false
			present.add(spec.local)
			return true
		})
		if (unique.length === 0) continue
		if (existing && !byDecl.has(existing)) {
			const last = existing.specifiers[existing.specifiers.length - 1]
			edits.push({ start: last.end, end: last.end, text: `, ${unique.map(renderSpec).join(', ')}` })
		} else linesOf.get(origin).unshift(renderSource(ctx, origin, unique, module))
	}
	for (const { decl } of planned) {
		const lines = linesOf.get(decl)
		if (lines.length > 0) {
			edits.push(replacement(ctx, decl, lines))
			continue
		}
		const edit = removal(ctx, decl)
		edits.push(edit)
		anchor ??= edit
	}
	if (addK) edits.push(kImport(ctx, anchor))
	return { edits, zodRemains, oldKitRemains }
}

function planKitDecl(ctx, decl, bindings, isLeft, withK) {
	const tracked = new Map(bindings.map((binding) => [binding.spec, binding]))
	const moved = new Map()
	const kept = []
	let changed = false
	let oldRemains = false
	const keepOld = (spec) => {
		kept.push(spec)
		oldRemains ||= decl.source.value === TABLE_MODULE
	}
	for (const spec of decl.specifiers) {
		const binding = tracked.get(spec)
		const original = specOf(importedName(spec), spec.local.name, spec.importKind === 'type')
		if (!binding || ZOD_INTEROP.has(binding.imported)) {
			if (binding) keepOld(original)
			else kept.push(original)
			continue
		}
		if (binding.imported === 'zid') {
			if (binding.refs.some(isLeft)) keepOld(original)
			else changed = true
			continue
		}
		const renamed = KIT_RENAMES.get(binding.imported)
		const local = renamed && binding.local === binding.imported ? renamed : binding.local
		const next = specOf(renamed ?? binding.imported, local, binding.isType)
		const module = movedModule(binding)
		if (module) {
			if (!moved.has(module)) moved.set(module, [])
			moved.get(module).push(next)
			changed = true
		} else if (renamed) {
			kept.push(next)
			changed = true
		} else kept.push(original)
	}
	if (!changed) return null
	if (withK) kept.push(specOf('k', 'k', false))
	const seen = new Set()
	const unique = kept.filter((spec) => !seen.has(spec.local) && seen.add(spec.local))
	const lines = []
	if (unique.length > 0) lines.push(renderSource(ctx, decl, unique))
	return { lines, moved, oldRemains }
}

function specOf(imported, local, isType) {
	return { imported, local, isType }
}

function renderSpec(spec) {
	const entry = spec.imported === spec.local ? spec.local : `${spec.imported} as ${spec.local}`
	return spec.isType ? `type ${entry}` : entry
}

function renderSource(ctx, decl, specs, module = decl.source.value) {
	const typeOnly = decl.importKind === 'type'
	const names = specs.map((spec) =>
		typeOnly ? renderSpec({ ...spec, isType: false }) : renderSpec(spec),
	)
	return `import ${typeOnly ? 'type ' : ''}{ ${names.join(', ')} } from '${module}'${semicolon(ctx, decl)}`
}

function semicolon(ctx, decl) {
	return ctx.source[decl.end - 1] === ';' ? ';' : ''
}

function removal(ctx, decl) {
	const end = ctx.source[decl.end] === '\n' ? decl.end + 1 : decl.end
	return { start: decl.start, end, text: '', decl }
}

function replacement(ctx, decl, lines) {
	return { start: decl.start, end: decl.end, text: lines.join('\n') }
}

function kImport(ctx, anchor) {
	if (ctx.kitRootDecl) {
		const specs = ctx.kitRootDecl.specifiers
		const last = specs[specs.length - 1]
		return last
			? { start: last.end, end: last.end, text: ', k' }
			: {
					start: ctx.kitRootDecl.start,
					end: ctx.kitRootDecl.end,
					text: `import { k } from 'cvx-kit'`,
				}
	}
	const style = anchor?.decl ?? ctx.program.body.find((node) => node.type === 'ImportDeclaration')
	const line = `import { k } from 'cvx-kit'${style ? semicolon(ctx, style) : ''}`
	if (anchor) {
		anchor.text = `${line}\n`
		return { start: anchor.start, end: anchor.start, text: '' }
	}
	const imports = ctx.program.body.filter((node) => node.type === 'ImportDeclaration')
	const last = imports[imports.length - 1]
	if (last) return { start: last.end, end: last.end, text: `\n${line}` }
	return { start: 0, end: 0, text: `${line}\n` }
}
