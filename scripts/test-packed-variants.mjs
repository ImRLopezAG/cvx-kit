import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { runOwnedProcess } from './owned-process.mjs'
import {
	localConvexEnvironment,
	assertIsolatedConvexFixture,
	assertLocalConvexState,
} from './convex-smoke-env.mjs'

// CI selects one package manager; unset preserves local compatibility matrices.
const installerOverride = process.env.CVX_PACKED_INSTALLER
if (installerOverride !== undefined && !['bun', 'npm'].includes(installerOverride))
	throw new Error('CVX_PACKED_INSTALLER must be bun or npm')
if (process.argv.length > 2) throw new Error('This script accepts no command-line arguments')

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const proof = mkdtempSync(join(tmpdir(), 'cvx-kit-variants-'))
console.log(`Variant packed proof: ${proof}`)
function run(command, args, cwd, label, env = process.env) {
	try {
		const output = execFileSync(command, args, {
			cwd,
			env,
			encoding: 'utf8',
			stdio: 'pipe',
			timeout: 180000,
			maxBuffer: 8 * 1024 * 1024,
		})
		writeFileSync(join(proof, `${label}.log`), output)
		console.log(`${label}: passed`)
	} catch (error) {
		// Package-manager configuration may contain credentials; never retain install output.
		if (!label.endsWith('install'))
			writeFileSync(join(proof, `${label}.log`), `${error.stdout ?? ''}\n${error.stderr ?? ''}`)
		throw new Error(`${label} failed (exit ${error.status}); proof at ${proof}`)
	}
}
run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', proof], root, 'pack')
// Neither project installs zod: the v2 core does not need it.
for (const [label, installer, helpers] of [
	['installed', installerOverride ?? 'bun', manifest.devDependencies['convex-helpers']],
	['minimum', installerOverride ?? 'npm', '0.1.127'],
]) {
	const fixture = join(proof, label)
	mkdirSync(fixture)
	writeFileSync(
		join(fixture, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: {
				'cvx-kit': `file:${join(proof, `${manifest.name}-${manifest.version}.tgz`)}`,
				convex: manifest.devDependencies.convex,
				'convex-helpers': helpers,
				'convex-test': manifest.devDependencies['convex-test'],
				'vite-plus': manifest.devDependencies['vite-plus'],
				'@edge-runtime/vm': manifest.devDependencies['@edge-runtime/vm'],
				'@types/node': manifest.devDependencies['@types/node'],
				typescript: manifest.devDependencies.typescript,
			},
		}),
	)
	for (const name of ['variant-table.test.ts', 'variant-table-types.ts']) {
		const source = readFileSync(join(root, 'test', name), 'utf8')
			.replaceAll("'../src/table'", "'cvx-kit/table'")
			.replaceAll("'../src/k'", "'cvx-kit/k'")
			.replaceAll("'../src/json-schema'", "'cvx-kit/json-schema'")
			.replaceAll("'../src/relations'", "'cvx-kit/relations'")
		if (source.includes("'../src/")) throw new Error(`${name} imports an unmapped ../src module`)
		writeFileSync(join(fixture, name), source)
	}
	writeFileSync(
		join(fixture, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				target: 'ES2025',
				module: 'ESNext',
				moduleResolution: 'bundler',
				types: ['node'],
			},
			include: ['*.ts', 'convex/**/*.ts'],
		}),
	)
	writeFileSync(
		join(fixture, 'vite.config.ts'),
		"import { defineConfig } from 'vite-plus'; export default defineConfig({ test: { environment: 'edge-runtime' } })\n",
	)
	run(installer, ['install', '--ignore-scripts'], fixture, `${label}-install`)
	mkdirSync(join(fixture, 'convex'))
	writeFileSync(
		join(fixture, 'convex/schema.ts'),
		`
import { defineSchema, defineTable } from 'convex/server'
import { k } from 'cvx-kit/k'
import { kVariantTable } from 'cvx-kit/table'
export const payments = kVariantTable('payments', k.discriminatedUnion('type', [
 k.object({ type: k.literal('draft'), clientId: k.id('clients'), amount: k.number() }),
 k.object({ type: k.literal('creditor'), clientId: k.id('clients'), creditorId: k.id('creditors'), amount: k.number() }),
]), { discriminator: 'type', variants: {
 draft: { commandFields: ['clientId', 'amount'], publicFields: ['clientId'] },
 creditor: { commandFields: ['clientId', 'creditorId', 'amount'], publicFields: ['clientId', 'creditorId'] },
} })
export default defineSchema({ payments: payments.table, clients: defineTable({}), creditors: defineTable({}) })
`,
	)
	// Native codegen requires a configured application; create an isolated local backend.
	const codegenEnv = localConvexEnvironment()
	assertIsolatedConvexFixture(fixture)
	const freePort = async () => {
		const server = createServer()
		await new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		const port = server.address()?.port
		if (!port) throw new Error('Missing fixture port')
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		)
		return port
	}
	const native = await runOwnedProcess({
		command: process.execPath,
		args: [
			join(fixture, 'node_modules/convex/bin/main.js'),
			'dev',
			'--once',
			'--typecheck=disable',
			'--local-cloud-port',
			String(await freePort()),
			'--local-site-port',
			String(await freePort()),
		],
		cwd: fixture,
		env: codegenEnv,
	})
	writeFileSync(join(proof, `${label}-native.log`), native.stdout + native.stderr)
	if (native.code !== 0 || native.timedOut || native.cleanup?.alive)
		throw new Error(`${label} native configuration failed; proof at ${proof}`)
	assertLocalConvexState(fixture)
	run(
		'node',
		[join(fixture, 'node_modules/convex/bin/main.js'), 'codegen', '--typecheck', 'disable'],
		fixture,
		`${label}-codegen`,
		codegenEnv,
	)
	writeFileSync(
		join(fixture, 'convex/types.ts'),
		`
import type { Doc, Id } from './_generated/dataModel'
import { expectTypeOf } from 'vite-plus/test'
declare const row: Doc<'payments'>
expectTypeOf(row._id).toEqualTypeOf<Id<'payments'>>()
expectTypeOf(row.clientId).toEqualTypeOf<Id<'clients'>>()
if (row.type === 'creditor') expectTypeOf(row.creditorId).toEqualTypeOf<Id<'creditors'>>()
if (row.type === 'draft') {
 // @ts-expect-error generated documents retain branch-specific fields
 row.creditorId
}
`,
	)
	run(
		join(fixture, 'node_modules/.bin/tsc'),
		['--project', 'tsconfig.json'],
		fixture,
		`${label}-types`,
	)
	run(
		join(fixture, 'node_modules/.bin/vp'),
		['test', 'run', 'variant-table.test.ts'],
		fixture,
		`${label}-runtime`,
	)
}
