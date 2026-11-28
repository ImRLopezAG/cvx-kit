// --restore-strict <git-ref>: for apps migrated by the beta.0–beta.2 codemod, which rewrote
// `z.strictObject(...)` and `.strict()` to a plain `k.object(...)` (strict at the time). From
// beta.3 a plain `k.object` strips unknown keys under `parse`, so this mode reads each file as it
// was at the pre-migration ref, pairs its Zod object factories with the file's current ones and
// turns the `k.object` of every pair that was strict into `k.strictObject`.
import { REPORT_FIXES } from './report-codes.mjs'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import {
	applyEdits,
	chainOf,
	isShadowed,
	lineIndex,
	parentMap,
	parseSource,
	walk,
} from './transforms/ast.mjs'

const FACTORIES = new Set(['object', 'strictObject', 'looseObject'])
const POLICIES = new Set(['strict', 'strip', 'loose', 'passthrough'])

/**
 * The object factory calls of a file in source order: `<root>.object|strictObject|looseObject(...)`
 * where `<root>` is a namespace imported from Zod or the kit and not shadowed locally. Each site has
 * the property-name signature of its field literal and the policy calls chained on it, the last
 * one declared first (the walk reaches the outermost call first).
 */
export function objectSites(path, source) {
	const parsed = parseSource(path, source)
	if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message)
	const roots = schemaRoots(parsed.program)
	const parents = parentMap(parsed.program)
	const position = lineIndex(source)
	const chained = new Map()
	const sites = []
	const aliasStrict = []
	walk(parsed.program, (node) => {
		if (node.type !== 'CallExpression') return
		const { root, steps } = chainOf(node)
		if (root.type !== 'Identifier' || isShadowed(root, root.name, parents)) return
		// Policies chained on a factory are recorded on the factory's own call node.
		const last = steps.at(-2)
		if (last?.kind !== 'member' || last.name === null) return
		const factory =
			steps[0]?.kind === 'member' && FACTORIES.has(steps[0].name) && roots.has(root.name)
		if (POLICIES.has(last.name)) {
			if (factory && steps[1]?.kind === 'call') {
				const calls = chained.get(steps[1].node) ?? []
				calls.push(last.name)
				chained.set(steps[1].node, calls)
			} else if (last.name === 'strict' && steps.length === 2) {
				aliasStrict.push({
					line: position(node.start).line,
					text: source.slice(node.start, node.end),
				})
			}
		}
		if (!factory || steps.length !== 2) return
		const kind = roots.get(root.name)
		sites.push({
			node,
			kind,
			factory: steps[0].name,
			name: steps[0].node.property,
			signature: signatureOf(node.arguments[0]),
			bindingPath: bindingPath(node, parents),
			line: position(node.start).line,
		})
	})
	for (const site of sites) site.policies = chained.get(site.node) ?? []
	return { sites, aliasStrict }
}

/** Local names that hold the Zod or kit schema namespace, mapped to `'z'` or `'k'`. */
function schemaRoots(program) {
	const roots = new Map()
	for (const statement of program.body) {
		if (statement.type !== 'ImportDeclaration') continue
		const from = statement.source.value
		const zod = from === 'zod' || from.startsWith('zod/')
		for (const specifier of statement.specifiers) {
			const local = specifier.local.name
			const imported = specifier.type === 'ImportSpecifier' ? specifier.imported.name : null
			if (zod && (imported === 'z' || imported === null)) roots.set(local, 'z')
			else if (imported === 'k') roots.set(local, 'k')
			else if (imported === 'z') roots.set(local, 'z')
		}
	}
	return roots
}

function signatureOf(argument) {
	if (argument?.type !== 'ObjectExpression') return '?'
	return argument.properties
		.map((property) => {
			if (property.type === 'SpreadElement') return '...'
			if (property.computed) return '[]'
			return property.key.type === 'Identifier' ? property.key.name : String(property.key.value)
		})
		.sort()
		.join(',')
}

/**
 * Pair moved objects by their enclosing binding/property path first. A remaining field signature
 * only pairs when unique on both sides; repeated anonymous signatures need manual review.
 */
export function pairSites(base, current) {
	const pairs = []
	const used = new Set()
	for (const site of base) {
		if (!site.bindingPath) continue
		const siblings = base.filter(
			(other) => other.bindingPath === site.bindingPath && same(site, other),
		)
		const targets = current.filter(
			(other) => other.bindingPath === site.bindingPath && same(site, other),
		)
		if (siblings.length === 1 && targets.length === 1) {
			pairs.push([site, targets[0]])
			used.add(targets[0])
		}
	}
	const paired = new Set(pairs.map(([site]) => site))
	const leftBase = groupBySignature(base.filter((site) => !paired.has(site)))
	const leftCurrent = groupBySignature(current.filter((site) => !used.has(site)))
	for (const [signature, sites] of leftBase) {
		const targets = leftCurrent.get(signature)
		if (signature !== '?' && sites.length === 1 && targets?.length === 1)
			pairs.push([sites[0], targets[0]])
	}
	return pairs
}

/** A stable binding and nested property path identifies moved objects with equal fields. */
function bindingPath(node, parents) {
	const path = []
	let bound = false
	for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
		if (parent.type === 'Property' && !parent.computed)
			path.unshift(parent.key.name ?? parent.key.value)
		if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
			path.unshift(parent.id.name)
			bound = true
		}
		if (parent.type === 'FunctionDeclaration' && parent.id) path.unshift(parent.id.name)
	}
	return bound ? path.join('.') : null
}

function groupBySignature(sites) {
	const groups = new Map()
	for (const site of sites) {
		const group = groups.get(site.signature) ?? []
		group.push(site)
		groups.set(site.signature, group)
	}
	return groups
}

/**
 * Leftover sites paired by order, when both sides have the same number left. Field names differ, so
 * these only tell whether the likely counterpart is already strict; they are never rewritten.
 */
function likelyCounterparts(base, current, paired) {
	const taken = new Set(paired.values())
	const leftBase = base.filter((site) => !paired.has(site))
	const leftCurrent = current.filter((site) => !taken.has(site))
	if (leftBase.length !== leftCurrent.length) return new Map()
	return new Map(leftBase.map((site, index) => [site, leftCurrent[index]]))
}

function isStrict(site) {
	const last = site.policies[0]
	return last === undefined ? site.factory === 'strictObject' : last === 'strict'
}

function same(left, right) {
	return left.signature === right.signature
}

/**
 * One file. `baseSource` is the file at the pre-migration ref (null when it did not exist there).
 * Returns the rewritten source and what was restored, already strict, or left for a person.
 */
export function restoreStrictSource(path, source, baseSource) {
	const outcome = { path, output: source, restored: 0, already: 0, manual: [] }
	if (baseSource === null) return outcome
	const current = objectSites(path, source)
	const base = objectSites(path, baseSource)
	const strictBase = base.sites.filter(isStrict)
	for (const site of base.aliasStrict)
		outcome.manual.push({
			code: 'strict-on-reference',
			baseLine: site.line,
			message: `${site.text} was strict through a reference; add .strict() to the matching k schema by hand`,
		})
	if (strictBase.length === 0) return outcome
	const paired = new Map(pairSites(base.sites, current.sites))
	const likely = likelyCounterparts(base.sites, current.sites, paired)
	const edits = []
	for (const site of strictBase) {
		const target = paired.get(site)
		if (target === undefined) {
			const ambiguous =
				(base.sites.filter((other) => same(other, site)).length > 1 ||
					current.sites.filter((other) => same(other, site)).length > 1) &&
				current.sites.some((other) => same(other, site))
			const counterpart = ambiguous ? undefined : likely.get(site)
			// Its fields changed or moved to a constant, but the object in its place is strict.
			if (counterpart !== undefined && isStrict(counterpart)) {
				outcome.already++
				continue
			}
			const review = {
				code: ambiguous ? 'strict-ambiguous' : 'strict-unpaired',
				baseLine: site.line,
				message: `no object with fields {${site.signature}} was found for the strict object at base line ${site.line}`,
			}
			if (counterpart !== undefined) {
				review.line = counterpart.line
				review.message += `; the object at line ${counterpart.line} of the current file may be it`
			}
			outcome.manual.push(review)
			continue
		}
		if (target.kind !== 'k') continue
		const last = target.policies[0]
		if ((target.factory === 'strictObject' && last === undefined) || last === 'strict') {
			outcome.already++
			continue
		}
		if (last !== undefined || target.factory !== 'object') {
			outcome.manual.push({
				code: 'strict-now-other-policy',
				baseLine: site.line,
				line: target.line,
				message: `was strict at base line ${site.line}; now ${target.factory}${last ? `().${last}()` : ''}: decide by hand`,
			})
			continue
		}
		edits.push({ start: target.name.start, end: target.name.end, text: 'strictObject' })
	}
	outcome.restored = edits.length
	outcome.output = applyEdits(source, edits)
	return outcome
}

/** The file at `ref`, or null when it does not exist there. */
export function gitReader(ref, cwd) {
	const git = (args) =>
		execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			maxBuffer: 64 * 1024 * 1024,
		})
	let top
	try {
		top = git(['rev-parse', '--show-toplevel']).trim()
		git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
	} catch {
		throw new Error(
			`--restore-strict: ${JSON.stringify(ref)} is not a commit of a git repository at ${cwd}`,
		)
	}
	return (file) => {
		// Both sides resolved, so a symlinked working directory still maps into the repository.
		const path = relative(realpathSync(top), realpathSync(resolve(cwd, file)))
			.split('\\')
			.join('/')
		try {
			return git(['show', `${ref}:${path}`])
		} catch {
			return null
		}
	}
}

export function formatRestoreSummary(results, ref, write) {
	const changed = results.filter((result) => result.restored > 0)
	const restored = results.reduce((sum, result) => sum + result.restored, 0)
	const already = results.reduce((sum, result) => sum + result.already, 0)
	const missing = results.filter((result) => result.noBase).length
	const errors = results.filter((result) => result.error)
	const manual = results.flatMap((result) =>
		result.manual.map((site) => ({ ...site, path: result.path })),
	)
	const lines = [
		`cvx-kit v2 codemod, restore strict objects from ${ref} (${write ? 'write' : 'dry run, nothing written'})`,
		`files: ${results.length} scanned, ${changed.length} ${write ? 'changed' : 'to change'}, ${missing} not present at ${ref}, ${errors.length} error`,
		`objects: ${restored} restored to k.strictObject, ${already} already strict, ${manual.length} for manual review`,
	]
	for (const result of errors) lines.push(`  error ${result.path}: ${result.error}`)
	if (manual.length > 0) {
		lines.push('manual review (line numbers are in the file at the base ref):')
		for (const site of manual)
			lines.push(`  ${site.path}:${site.baseLine} ${site.code}: ${site.message}`)
	}
	for (const code of new Set(manual.map((site) => site.code)))
		lines.push(`  ${code}: ${REPORT_FIXES[code]}`)
	return lines.join('\n')
}
