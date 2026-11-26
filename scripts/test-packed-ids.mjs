// Installs the packed tarball into projects WITHOUT `zod` and proves: every
// core entry imports, `cvx-kit/zod` fails with a clear module-not-found for
// `zod`, ids stay native `v.id` through every derived boundary, and the
// table, agent-tool and command suites pass against the packed package.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// CI selects one package manager; unset preserves local compatibility matrices.
const installerOverride = process.env.CVX_PACKED_INSTALLER
if (installerOverride !== undefined && !['bun', 'npm'].includes(installerOverride))
	throw new Error('CVX_PACKED_INSTALLER must be bun or npm')
if (process.argv.length > 2) throw new Error('This script accepts no command-line arguments')

const root = join(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-ids-'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const esbuild = createRequire(join(root, 'package.json'))('esbuild')
function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'pipe',
	})
}

/** Copies a repository test into the fixture with its `../src/*` imports mapped to package entries. */
function copyTest(fixture, testFile) {
	const source = readFileSync(join(root, 'test', testFile), 'utf8')
		.replaceAll("'../src/components/foundation/client'", "'cvx-kit/components/foundation'")
		.replaceAll("'../src/contracts'", "'cvx-kit/contracts'")
		.replaceAll("'../src/table'", "'cvx-kit/table'")
		.replaceAll("'../src/k'", "'cvx-kit/k'")
		.replaceAll("'../src/json-schema'", "'cvx-kit/json-schema'")
		.replaceAll("'../src/agent-tools'", "'cvx-kit/agent-tools'")
		// The root entry re-exports the namespace helpers.
		.replaceAll("'../src/namespace'", "'cvx-kit'")
		.replaceAll("'../src/index'", "'cvx-kit'")
		.replace(
			"const modules = import.meta.glob('./fixture/**/*.ts')",
			"const modules = { './_generated/server.ts': async () => ({}) }",
		)
	if (source.includes("'../src/")) throw new Error(`${testFile} imports an unmapped ../src module`)
	writeFileSync(join(fixture, testFile), source)
}

const entriesProbe = `
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
const manifest = JSON.parse(readFileSync('node_modules/cvx-kit/package.json', 'utf8'))
// Entries that need an optional peer this project does not install.
const needsPeer = { './effect': 'effect', './react': 'react' }
const skipped = new Set(['./package.json', './test', './zod'])
// Component configs are bundled by Convex, not imported by Node (their component
// dependencies use extensionless ESM imports); the script bundles them instead.
const bundled = (key) => key.includes('convex.config')
const imported = []
for (const [key, target] of Object.entries(manifest.exports)) {
	// Types-only entries (no runtime condition) have nothing to import.
	if (skipped.has(key) || bundled(key) || (typeof target === 'object' && !target.import && !target.default))
		continue
	const specifier = 'cvx-kit' + key.slice(1)
	try {
		await import(specifier)
		imported.push(key)
	} catch (error) {
		const peer = needsPeer[key]
		assert.ok(
			peer && error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'" + peer + "'"),
			specifier + ' failed without zod: ' + error.message,
		)
	}
}
assert.ok(imported.length >= 20, 'only ' + imported.length + ' core entries imported')
await assert.rejects(import('cvx-kit/zod'), (error) => {
	assert.equal(error.code, 'ERR_MODULE_NOT_FOUND')
	assert.match(error.message, /Cannot find package 'zod'/)
	return true
})
console.log(imported.length + ' core entries import without zod; cvx-kit/zod fails with module-not-found for zod')
`

const idsProbe = `
import { strict as assert } from 'node:assert'
import { k } from 'cvx-kit/k'
import { tenantTable } from 'cvx-kit/table'
const table = tenantTable('children', {
	parentId: k.id('parents'),
	nested: k.object({ parentId: k.id('parents') }),
}, { commandFields: ['parentId', 'nested'], publicFields: ['parentId', 'nested'] })
for (const validator of [
	k.id('parents').validator,
	table.table.validator.fields.parentId,
	table.storage.validator.fields.parentId,
	table.commandInput.validator.fields.parentId,
	table.publicDto.validator.fields.parentId,
	table.storage.validator.fields.nested.fields.parentId,
	table.commandInput.validator.fields.nested.fields.parentId,
	table.publicDto.validator.fields.nested.fields.parentId,
]) {
	assert.equal(validator.kind, 'id', 'exported schema lost ID validation')
	assert.equal(validator.tableName, 'parents')
}
assert.equal(table.tools.update.validator.fields.id.kind, 'id')
assert.equal(table.tools.update.validator.fields.id.tableName, 'children')
`

try {
	run('bun', ['pm', 'pack', '--destination', temporary, '--ignore-scripts'], root)
	for (const installer of installerOverride ? [installerOverride] : ['npm', 'bun']) {
		const fixture = join(temporary, installer)
		mkdirSync(fixture)
		writeFileSync(
			join(fixture, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${join(temporary, `cvx-kit-${manifest.version}.tgz`)}`,
					'convex-helpers': '0.1.130',
					convex: manifest.devDependencies.convex,
				},
				devDependencies: {
					'convex-test': manifest.devDependencies['convex-test'],
					'vite-plus': manifest.devDependencies['vite-plus'],
					'@edge-runtime/vm': manifest.devDependencies['@edge-runtime/vm'],
				},
			}),
		)
		run(installer, ['install', '--ignore-scripts'], fixture)
		if (existsSync(join(fixture, 'node_modules', 'zod')))
			throw new Error(`${installer}: zod was installed into a project that does not depend on it`)
		writeFileSync(join(fixture, 'entries.mjs'), entriesProbe)
		console.log(`${installer}: ${run('node', ['entries.mjs'], fixture).trim()}`)
		for (const key of Object.keys(manifest.exports).filter((key) =>
			key.includes('convex.config'),
		)) {
			const result = await esbuild.build({
				absWorkingDir: fixture,
				stdin: { contents: `export * from 'cvx-kit${key.slice(1)}'`, resolveDir: fixture },
				bundle: true,
				write: false,
				platform: 'browser',
				format: 'esm',
				conditions: ['convex', 'module'],
				logLevel: 'silent',
				metafile: true,
			})
			const zodInputs = Object.keys(result.metafile.inputs).filter((input) =>
				/node_modules\/zod\//.test(input),
			)
			if (zodInputs.length) throw new Error(`cvx-kit${key.slice(1)} bundles zod: ${zodInputs[0]}`)
		}
		writeFileSync(join(fixture, 'probe.mjs'), idsProbe)
		run('node', ['probe.mjs'], fixture)
		for (const testFile of [
			'command.test.ts',
			'command-lifecycle.test.ts',
			'command-types.ts',
			'table.test.ts',
			'table-types.ts',
			'agent-tools.test.ts',
		])
			copyTest(fixture, testFile)
		writeFileSync(
			join(fixture, 'registration.test.ts'),
			`
import { convexTest } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { registerFoundation, registerApprovals } from 'cvx-kit/test'
import { it } from 'vite-plus/test'
it('registers concrete and generic backends from the packed package', () => {
 const modules = { './_generated/server.ts': async () => ({}) }
 const concrete = convexTest(defineSchema({ items: defineTable({ name: v.string() }) }), modules)
 const generic = convexTest(undefined, modules)
 for (const backend of [concrete, generic]) {
  registerFoundation(backend)
  registerApprovals(backend)
  registerFoundation(backend, 'customFoundation')
  registerApprovals(backend, 'customApprovals')
 }
})
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
				'--types',
				'vite/client',
				'command-types.ts',
				'registration.test.ts',
				'table.test.ts',
				'table-types.ts',
				'agent-tools.test.ts',
			],
			fixture,
		)
		run(
			join(fixture, 'node_modules/.bin/vp'),
			[
				'test',
				'run',
				'registration.test.ts',
				'command.test.ts',
				'command-lifecycle.test.ts',
				'table.test.ts',
				'agent-tools.test.ts',
			],
			fixture,
		)
		console.log(
			`${installer}: packed IDs, table/tool types, registration, and command lifecycle pass without zod installed, with host convex-helpers 0.1.130`,
		)
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
