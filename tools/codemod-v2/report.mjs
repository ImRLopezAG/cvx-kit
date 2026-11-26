// Aggregates per-file codemod results into the JSON report and the printed
// totals-only summary.

const STATUSES = ['rewritten', 'mixed', 'kept', 'untouched', 'error']

export function buildReport(results) {
	const files = results.map(({ output: _output, ...file }) => file)
	const summary = Object.fromEntries([
		['scanned', files.length],
		...STATUSES.map((status) => [status, 0]),
	])
	const totals = {}
	const info = {}
	const declarations = { rewritten: 0, left: 0 }
	for (const file of files) {
		summary[file.status]++
		declarations.rewritten += file.declarations.rewritten
		declarations.left += file.declarations.left
		for (const site of file.skipped) totals[site.code] = (totals[site.code] ?? 0) + 1
		for (const site of file.info) info[site.code] = (info[site.code] ?? 0) + 1
	}
	const considered = declarations.rewritten + declarations.left
	return {
		summary,
		declarations,
		mechanicalShare:
			considered === 0 ? 1 : Number((declarations.rewritten / considered).toFixed(4)),
		totals: sortedCounts(totals),
		info: sortedCounts(info),
		files,
	}
}

function sortedCounts(counts) {
	return Object.fromEntries(
		Object.entries(counts).sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		),
	)
}

export function formatSummary(report, write) {
	const { summary, declarations } = report
	const lines = [
		`cvx-kit v2 codemod (${write ? 'write' : 'dry run, nothing written'})`,
		`files: ${summary.scanned} scanned, ${STATUSES.map((status) => `${summary[status]} ${status}`).join(', ')}`,
		declarations.rewritten + declarations.left === 0
			? 'declarations: none found'
			: `declarations: ${declarations.rewritten} rewritten, ${declarations.left} left as Zod (mechanical share ${(report.mechanicalShare * 100).toFixed(1)}%)`,
	]
	const totals = Object.entries(report.totals)
	if (totals.length > 0) {
		lines.push('skipped sites by code:')
		for (const [code, count] of totals) lines.push(`  ${code}: ${count}`)
	}
	const info = Object.entries(report.info)
	if (info.length > 0) {
		lines.push('informational:')
		for (const [code, count] of info) lines.push(`  ${code}: ${count}`)
	}
	return lines.join('\n')
}
