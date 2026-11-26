// Imports: resolves what `z` and the kit names are bound to, then plans the
// import edits once every unit's fate is known (add `k`, drop Zod when unused,
// move `cvx-kit/zod-table` names to `cvx-kit/table`, rename kit helpers).

export const ZOD_MODULES = new Set(['zod', 'zod/v4', 'zod/v3'])
const TABLE_MODULE = 'cvx-kit/zod-table'
const NEXT_TABLE_MODULE = 'cvx-kit/table'
const ZID_MODULES = new Set(['convex-helpers/server/zod4', 'convex-helpers/server/zod'])
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
])

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
			if (module === 'cvx-kit' && spec.type === 'ImportSpecifier' && importedName(spec) === 'k') {
				ctx.hasK = true
			} else ctx.kConflict = spec
		}
	}
	if (module === 'cvx-kit' && decl.importKind !== 'type' && decl.specifiers.every(isNamed)) {
		ctx.kitRootDecl ??= decl
	}
	if (!tracked || !decl.specifiers.every(isNamed)) return
	for (const spec of decl.specifiers) {
		const imported = importedName(spec)
		const wanted =
			module === TABLE_MODULE ||
			(ZID_MODULES.has(module) && imported === 'zid') ||
			names?.has(imported) === true
		if (!wanted) continue
		ctx.kit.set(spec.local.name, {
			local: spec.local.name,
			imported,
			module,
			decl,
			spec,
			isType: spec.importKind === 'type',
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
	for (const [decl, bindings] of byDecl) {
		const withK = addK && decl === ctx.kitRootDecl
		const planned = planKitDecl(ctx, decl, bindings, isLeft, withK)
		if (!planned) continue
		if (withK) addK = false
		oldKitRemains ||= planned.oldRemains
		if (planned.lines.length > 0) {
			edits.push(replacement(ctx, decl, planned.lines))
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
	const moved = []
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
		const needOld = binding.refs.some(isLeft)
		const needNew = binding.refs.length === 0 || binding.refs.some((unit) => !isLeft(unit))
		const renamed = KIT_RENAMES.get(binding.imported)
		if (needOld) {
			keepOld(original)
			if (renamed) oldRemains = true
		}
		if (binding.imported === 'zid') {
			changed ||= !needOld
			continue
		}
		if (!needNew) continue
		const local = renamed && binding.local === binding.imported ? renamed : binding.local
		const next = specOf(renamed ?? binding.imported, local, binding.isType)
		if (binding.module === TABLE_MODULE) {
			moved.push(next)
			changed = true
		} else if (renamed) {
			kept.push(next)
			changed = true
		} else if (!needOld) kept.push(original)
	}
	if (!changed) return null
	if (withK) kept.push(specOf('k', 'k', false))
	const lines = []
	if (moved.length > 0) lines.push(renderSource(ctx, decl, moved, NEXT_TABLE_MODULE))
	if (kept.length > 0) lines.push(renderSource(ctx, decl, kept))
	return { lines, oldRemains }
}

function specOf(imported, local, isType) {
	return { imported, local, isType }
}

function renderSource(ctx, decl, specs, module = decl.source.value) {
	const typeOnly = decl.importKind === 'type'
	const names = specs.map((spec) => {
		const entry = spec.imported === spec.local ? spec.local : `${spec.imported} as ${spec.local}`
		return spec.isType && !typeOnly ? `type ${entry}` : entry
	})
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
