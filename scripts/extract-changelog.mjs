// Extracts one version's section from CHANGELOG.md (Keep a Changelog form).
// Usage: node scripts/extract-changelog.mjs 0.1.0 [outfile]
// Used by the release workflow for GitHub Release notes, and runnable
// locally BEFORE tagging to verify extraction (see the release plan).
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!version) {
	console.error('usage: extract-changelog.mjs <version> [outfile]')
	process.exit(1)
}
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const pattern = new RegExp(
	String.raw`^## \[${version.replace(/\./g, String.raw`\.`)}\][^\n]*\n([\s\S]*?)(?=^## \[|\Z)`,
	'm',
)
const match = changelog.match(pattern)
if (!match) {
	console.error(`CHANGELOG.md has no section for version ${version}`)
	process.exit(1)
}
const notes = match[1].trim()
if (!notes) {
	console.error(`CHANGELOG.md section for ${version} is empty`)
	process.exit(1)
}
const outfile = process.argv[3]
if (outfile) writeFileSync(outfile, `${notes}\n`)
else process.stdout.write(`${notes}\n`)
