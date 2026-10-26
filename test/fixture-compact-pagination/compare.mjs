import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Compare only receipts produced from the official native static API and the
// actual packed registrations. ID retention has an independently reported floor.
export function compare(baseline, candidate, destination) {
	const load = (p) => JSON.parse(readFileSync(join(p, 'measurements.json'), 'utf8'))
	const base = load(baseline),
		next = load(candidate)
	const result = { baseline, candidate, fixtures: {} }
	for (const name of ['scalar', 'relation', 'idHeavy', 'variantIds']) {
		const validator = {
			baseline: base.validators[name].bytes,
			candidate: next.validators[name].bytes,
		}
		validator.reduction = validator.baseline / validator.candidate
		const declaration = {
			baseline: base.api.argumentsByFunction[name].bytes,
			candidate: next.api.argumentsByFunction[name].bytes,
		}
		declaration.reduction = declaration.baseline / declaration.candidate
		result.fixtures[name] = { validator, declaration }
	}
	result.totalApi = {
		baselineBytes: base.api.bytes,
		candidateBytes: next.api.bytes,
		reduction: base.api.bytes / next.api.bytes,
		baselineLines: base.api.lines,
		candidateLines: next.api.lines,
	}
	// Retain the measured result even when an acceptance assertion is RED.
	writeFileSync(destination, JSON.stringify(result, null, 2))
	assert.ok(
		result.fixtures.scalar.validator.reduction >= 10,
		'scalar registered validator must shrink at least 10x',
	)
	assert.ok(
		result.fixtures.scalar.declaration.reduction >= 10,
		'actual scalar generated arguments must shrink at least 10x',
	)
	assert.ok(
		result.fixtures.scalar.validator.candidate <= 40 * 1024,
		'scalar registered validator must fit 40 KiB',
	)
	assert.ok(
		result.fixtures.relation.validator.reduction >= 10,
		'relation/variant registered validator reduction',
	)
	assert.ok(
		result.fixtures.relation.declaration.reduction >= 10,
		'relation/variant generated argument reduction',
	)
	for (const name of ['idHeavy', 'variantIds']) {
		assert.ok(
			result.fixtures[name].validator.reduction >= 1,
			name + ' registered validator must not grow',
		)
		assert.ok(
			result.fixtures[name].declaration.reduction >= 1,
			name + ' generated arguments must not grow',
		)
	}
	return result
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
	const [baseline, candidate, destination] = process.argv.slice(2)
	assert.ok(
		baseline && candidate && destination,
		'Usage: node compare.mjs baseline-evidence candidate-evidence output.json',
	)
	console.log(JSON.stringify(compare(baseline, candidate, destination), null, 2))
}
