// Records rewrite edits, skipped sites and informational notes on a unit (one
// top-level statement). Edits only land when the unit's component is rewritten.

export function addSkip(ctx, unit, range, code) {
	unit.skips.push(siteOf(ctx, range, code))
}

/** A site left for manual work that does not hold the rest of its unit as Zod. */
export function addManual(ctx, unit, range, code) {
	unit.manual.push(siteOf(ctx, range, code))
}

export function addInfo(ctx, unit, range, code) {
	unit.info.push(siteOf(ctx, range, code))
}

export function addEdit(unit, range, text, usesK = false) {
	unit.edits.push({ start: range.start, end: range.end, text, usesK })
}

function siteOf(ctx, range, code) {
	const { line, column } = ctx.position(range.start)
	const text = ctx.source.slice(range.start, range.end).replace(/\s+/g, ' ').slice(0, 80)
	return { line, column, code, text }
}
