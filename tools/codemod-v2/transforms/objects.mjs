// Strict objects: `k.object` rejects unknown keys where `z.object` stripped
// them. Where a schema only reaches kit boundaries (table fields, function
// args/returns, contracts), Convex already rejected unknown keys, so nothing
// changes. A schema that is parsed changes behaviour, so each rewritten object
// is classified by how its declaration is used:
//
// - parsed: the declaration (or one that nests or derives from it) is parsed in
//   this file (`.parse`, `.safeParse`, `.parseAsync`, `.safeParseAsync`), is
//   parsed by another file of the run that imports it, or is exported and no
//   file of the run imports it (its consumers are unknown);
// - boundary-only: every other object.
//
// With `stripParsed` (the default) a parsed object gets `.strip()`, which keeps
// v1's parse behaviour exactly and leaves the native validator strict; the site
// is reported as `object-parsed-stripped`. Without it the site is reported as
// `object-parsed-now-strict`. Boundary-only sites keep `object-now-strict`. An
// object that already states `.strict()` / `.strip()`, or is `z.strictObject`,
// is left as declared.
import { addEdit, addInfo } from './sites.mjs'

export function classifyObjects(ctx, units, isLeft) {
	const exported = exportedNames(ctx)
	const parsed = new Set()
	const queue = []
	const mark = (unit) => {
		if (parsed.has(unit)) return
		parsed.add(unit)
		queue.push(unit)
	}
	for (const unit of units) {
		for (const name of namesOf(unit)) {
			if (ctx.parsedNames.has(name)) mark(unit)
			for (const exportedName of exported.get(name) ?? []) {
				const run = ctx.options.run
				if (!run) continue
				if (run.isParsed(ctx.path, exportedName) || !run.isImported(ctx.path, exportedName))
					mark(unit)
			}
		}
	}
	while (queue.length > 0) {
		const unit = queue.pop()
		for (const ref of unit.refs) for (const owner of ctx.owners.get(ref.name) ?? []) mark(owner)
	}
	for (const unit of units) {
		if (isLeft(unit)) continue
		for (const object of unit.objectSites) {
			if (!parsed.has(unit)) {
				if (!object.derived && !object.strict) addInfo(ctx, unit, object.site, 'object-now-strict')
				continue
			}
			if (object.strict) continue
			// A derived object keeps its source's policy in Zod and in `k`: only a source that strips in
			// Zod (`z.object`) needs `.strip()` restated; a loose or strict source is already right.
			if (object.derived && object.policy !== 'strip') {
				if (object.policy === null) addInfo(ctx, unit, object.site, 'derived-policy-unproven')
				continue
			}
			if (ctx.options.stripParsed) {
				addEdit(unit, { start: object.end, end: object.end }, '.strip()')
				addInfo(ctx, unit, object.site, 'object-parsed-stripped')
			} else addInfo(ctx, unit, object.site, 'object-parsed-now-strict')
		}
	}
}

function namesOf(unit) {
	const declaration = unit.declaration
	if (declaration.type === 'VariableDeclaration')
		return declaration.declarations.flatMap((declarator) =>
			declarator.id.type === 'Identifier' ? [declarator.id.name] : [],
		)
	return declaration.id?.type === 'Identifier' ? [declaration.id.name] : []
}

/** Local name to the names it is exported as. */
function exportedNames(ctx) {
	const out = new Map()
	const add = (local, name) => {
		if (!out.has(local)) out.set(local, [])
		out.get(local).push(name)
	}
	for (const node of ctx.program.body) {
		if (node.type !== 'ExportNamedDeclaration' || node.source) continue
		if (node.declaration) {
			const declaration = node.declaration
			if (declaration.type === 'VariableDeclaration') {
				for (const declarator of declaration.declarations)
					if (declarator.id.type === 'Identifier') add(declarator.id.name, declarator.id.name)
			} else if (declaration.id?.type === 'Identifier')
				add(declaration.id.name, declaration.id.name)
			continue
		}
		for (const spec of node.specifiers) {
			if (spec.local.type !== 'Identifier') continue
			add(
				spec.local.name,
				spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value,
			)
		}
	}
	return out
}
