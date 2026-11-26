// Type-cost benchmark: run `tsc --extendedDiagnostics` on each flavor's
// emitted module from a directory that resolves this checkout's node_modules.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Typechecks each `[flavor, source]` entry and returns
 * `{ [flavor]: { types, instantiations, checkMs } | { error } }`.
 * A flavor whose source has type errors reports `{ error }` with the first errors.
 */
export function typecheck(checkout, sources) {
	const cache = path.join(checkout, 'node_modules', '.cache')
	fs.mkdirSync(cache, { recursive: true })
	const dir = fs.mkdtempSync(path.join(cache, 'cvx-bench-validators-'))
	const tsc = path.join(checkout, 'node_modules', '.bin', 'tsc')
	const results = {}
	try {
		for (const [flavor, source] of sources) {
			const file = path.join(dir, `${flavor}.ts`)
			const config = path.join(dir, `tsconfig.${flavor}.json`)
			fs.writeFileSync(file, source)
			fs.writeFileSync(
				config,
				JSON.stringify({
					compilerOptions: {
						target: 'ES2022',
						lib: ['ES2022', 'DOM'],
						module: 'ESNext',
						moduleResolution: 'bundler',
						strict: true,
						skipLibCheck: true,
						noEmit: true,
						allowImportingTsExtensions: true,
						types: [],
					},
					files: [file],
				}),
			)
			let output
			let failed = false
			try {
				output = execFileSync(tsc, ['-p', config, '--extendedDiagnostics', '--pretty', 'false'], {
					cwd: dir,
					maxBuffer: 64 * 1024 * 1024,
				}).toString()
			} catch (error) {
				failed = true
				output = `${error.stdout ?? ''}${error.stderr ?? ''}`
			}
			const errors = output.split('\n').filter((line) => /error TS\d+/.test(line))
			if (failed || errors.length) {
				results[flavor] = { error: errors.slice(0, 5).join('\n') || output.slice(0, 2000) }
				continue
			}
			const metric = (label) => {
				const match = new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(output)
				if (!match) throw new Error(`tsc did not report ${label} for ${flavor}`)
				return Number(match[1])
			}
			results[flavor] = {
				types: metric('Types'),
				instantiations: metric('Instantiations'),
				checkMs: Math.round(metric('Check time') * 1000),
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
	return results
}
