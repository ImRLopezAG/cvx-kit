import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rules } from '../dist/oxlint.mjs'

const root = join(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-oxlint-'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ruleNames = Object.keys(rules)
assert.equal(ruleNames.length, 6)

try {
	run('bun', ['pm', 'pack', '--destination', temporary, '--ignore-scripts'], root)
	for (const installer of ['npm', 'bun']) {
		const fixture = join(temporary, installer)
		mkdirSync(join(fixture, 'src/components/example'), { recursive: true })
		writeFileSync(
			join(fixture, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${join(temporary, `cvx-kit-${manifest.version}.tgz`)}`,
					convex: manifest.devDependencies.convex,
					'convex-helpers': manifest.devDependencies['convex-helpers'],
					zod: manifest.devDependencies.zod,
				},
				devDependencies: { oxlint: manifest.devDependencies.oxlint },
			}),
		)
		run(installer, ['install', '--ignore-scripts'], fixture)
		writeFileSync(
			join(fixture, '.oxlintrc.json'),
			JSON.stringify({
				jsPlugins: [{ name: 'cvx', specifier: 'cvx-kit/oxlint' }],
				rules: {
					...Object.fromEntries(ruleNames.map((name) => [`cvx/${name}`, 'error'])),
					'cvx/no-internal-reexports': ['error', { entryPoints: ['src/public.ts'] }],
				},
			}),
		)
		writeFileSync(
			join(fixture, 'src/public.ts'),
			"export { run } from './components/example/client'\n",
		)
		writeFileSync(
			join(fixture, 'src/components/example/client.ts'),
			'export function run() { return 1 }\n',
		)
		const oxlint = join(fixture, 'node_modules/.bin/oxlint')
		run(oxlint, ['--config', '.oxlintrc.json', 'src'], fixture)
		writeFileSync(
			join(fixture, 'src/components/example/bad.ts'),
			`
import { defineTable } from 'convex/server'
import { host } from '../../host'
function helper() { return process.env.SECRET }
const privateHelper = () => helper()
export const table = defineTable({})
export { host }
export const value = privateHelper()
`,
		)
		writeFileSync(
			join(fixture, 'src/host.ts'),
			"export const host = 1\nimport './components/example/bad'\n",
		)
		const invalid = spawnSync(oxlint, ['--config', '.oxlintrc.json', '--format', 'json', 'src'], {
			cwd: fixture,
			encoding: 'utf8',
		})
		assert.ifError(invalid.error)
		assert.equal(invalid.status, 1, invalid.stderr)
		const diagnostics = JSON.parse(invalid.stdout).diagnostics
		for (const name of ruleNames) {
			assert.ok(
				diagnostics.some((item) => item.code === `cvx(${name})`),
				`${installer}: missing ${name}: ${invalid.stdout}`,
			)
		}
		writeFileSync(
			join(fixture, 'plugin-types.ts'),
			`
import plugin, { rules, type RuleName } from 'cvx-kit/oxlint'
import type { Plugin, Rule } from '@oxlint/plugins'
const compatible: Plugin = plugin
const name: RuleName = 'component-boundaries'
const rule: Rule = rules[name]
void compatible
void rule
`,
		)
		run(
			join(root, 'node_modules/.bin/tsc'),
			[
				'--noEmit',
				'--strict',
				'--skipLibCheck',
				'--target',
				'es2025',
				'--module',
				'esnext',
				'--moduleResolution',
				'bundler',
				'plugin-types.ts',
			],
			fixture,
		)
		console.log(
			`${installer}: packed Oxlint plugin loads, all six rules report, and declarations typecheck`,
		)
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}
