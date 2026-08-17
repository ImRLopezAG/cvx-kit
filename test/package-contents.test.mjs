// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

const packedFiles = (() => {
	const env = { ...process.env }
	delete env.NODE_AUTH_TOKEN
	delete env.NPM_CONFIG_USERCONFIG
	const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
		cwd: process.cwd(),
		encoding: 'utf8',
		env,
	})
	const [pack] = JSON.parse(output)
	if (!pack?.files) throw new Error('npm pack returned no package manifest')
	return pack.files.map((file) => file.path)
})()

describe('packed Convex components', () => {
	it.each(['approvals', 'foundation'])(
		'publishes one discoverable schema module for %s',
		(component) => {
			const prefix = `dist/components/${component}/schema.`
			const schemas = packedFiles.filter((file) => file.startsWith(prefix))
			expect(schemas).toEqual([
				`dist/components/${component}/schema.d.ts`,
				`dist/components/${component}/schema.js`,
			])
		},
	)

	it('points the shipped test helper at the discoverable schemas', () => {
		const source = readFileSync(join(process.cwd(), 'src/test.ts'), 'utf8')
		expect(source).toContain('../dist/components/approvals/schema.js')
		expect(source).toContain('../dist/components/foundation/schema.js')
		expect(source).not.toMatch(/schema\.mjs/)
	})

	it.each(['approvals', 'foundation'])(
		'keeps generated data-model types aligned with the %s schema filename',
		(component) => {
			const declaration = readFileSync(
				join(
					process.cwd(),
					'dist',
					'components',
					component,
					'_generated',
					'dataModel.d.mts',
				),
				'utf8',
			)
			expect(declaration).toContain('../schema.js')
			expect(declaration).not.toContain('../schema.mjs')
		},
	)

	it('rewrites runtime imports to the discoverable approvals schema', () => {
		const requests = readFileSync(
			join(
				process.cwd(),
				'dist',
				'components',
				'approvals',
				'requests.mjs',
			),
			'utf8',
		)
		expect(requests).toContain('./schema.js')
		expect(requests).not.toContain('./schema.mjs')
	})
})
