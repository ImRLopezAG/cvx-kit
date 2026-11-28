// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vite-plus/test'

const checkout = resolve(import.meta.dirname, '..')
const esbuild = createRequire(join(checkout, 'package.json'))('esbuild')
const dir = mkdtempSync(join(tmpdir(), 'cvx-bundle-effect-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const src = (file) => JSON.stringify(join(checkout, file))

/** Bundle `source` the way Convex does (browser, ESM, `convex,module`) and return input bytes. */
async function bundle(name, source) {
	const entry = join(dir, `${name}.ts`)
	writeFileSync(entry, source)
	const result = await esbuild.build({
		absWorkingDir: checkout,
		entryPoints: [entry],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'esnext',
		outfile: join(dir, `${name}.mjs`),
		conditions: ['convex', 'module'],
		treeShaking: true,
		logLevel: 'silent',
		external: ['node:*'],
		nodePaths: [join(checkout, 'node_modules')],
		metafile: true,
	})
	const output = Object.values(result.metafile.outputs).find((item) => item.entryPoint)
	return Object.entries(output.inputs)
		.filter(([, { bytesInOutput }]) => bytesInOutput > 0)
		.map(([input, { bytesInOutput }]) => ({ input, bytes: bytesInOutput }))
}
const bytes = (inputs, pattern) =>
	inputs.filter(({ input }) => pattern.test(input)).reduce((sum, item) => sum + item.bytes, 0)

const schemaFiles = /node_modules\/effect\/dist\/(Schema|SchemaAST)\.js$/

const operations = `
import { Effect } from 'effect'
import { mutationGeneric, queryGeneric } from 'convex/server'
import { NoOp } from 'convex-helpers/server/customFunctions'
import { createEffectFoundation, effectApiBuilder } from ${src('src/effect.ts')}
import { defineDomainContract } from ${src('src/contracts.ts')}
import { k } from ${src('src/k.ts')}
import { kCustomMutation, kCustomQuery } from ${src('src/registration.ts')}

const contract = defineDomainContract({
	commands: { save: { input: k.object({ name: k.string() }), result: k.string(), classification: 'business' } },
	queries: { read: { input: k.object({ id: k.string() }), result: k.string() } },
})
const { Command, Query } = createEffectFoundation({
	observability: { enabled: false, classifyError: () => ({ outcome: 'failed', errorCode: 'FAILED' }) },
	writeAudit: () => undefined,
})
const commands = Command({
	contract,
	context: (ctx) => ctx,
	operations: ({ command }) => ({
		save: command.save({ audit: () => null, handler: (input) => Effect.succeed(input.name) }),
	}),
})
const queries = Query({
	contract,
	context: (ctx) => ctx,
	operations: ({ query }) => ({ read: query.handler(({ id }) => Effect.succeed(id)) }),
})
const mutation = effectApiBuilder(kCustomMutation(mutationGeneric, NoOp), {})
const query = effectApiBuilder(kCustomQuery(queryGeneric, NoOp), {})
export const save = mutation({
	args: { name: k.string() },
	returns: k.string(),
	handler: (ctx, input) => commands.exec('save', input, ctx),
})
export const read = query({
	args: { id: k.string() },
	returns: k.string(),
	handler: (ctx, input) => queries.exec('read', input, ctx),
})
`

describe('Effect bundles', () => {
	it('keep effect/Schema out of a module declaring an Effect command and query with k inputs', async () => {
		const inputs = await bundle('operations', operations)
		expect(bytes(inputs, /src\/modules\/effect\/command\.ts$/)).toBeGreaterThan(0)
		expect(bytes(inputs, /src\/modules\/effect\/query\.ts$/)).toBeGreaterThan(0)
		expect(bytes(inputs, schemaFiles)).toBe(0)
	})

	it('bundle effect/Schema once a module uses effectSchema', async () => {
		const inputs = await bundle(
			'effect-schema',
			`import { Schema } from 'effect'
import { effectSchema } from ${src('src/effect.ts')}
export const codec = effectSchema(Schema.Struct({ name: Schema.String }))
`,
		)
		expect(bytes(inputs, /node_modules\/effect\/dist\/Schema\.js$/)).toBeGreaterThan(0)
		expect(bytes(inputs, /node_modules\/effect\/dist\/SchemaAST\.js$/)).toBeGreaterThan(0)
	})
})

describe('schema error recognition', () => {
	it('uses the type id effect/Schema stamps on SchemaError', async () => {
		const { Schema } = await import('effect')
		const error = Schema.decodeUnknownExit(Schema.String)(1)
		const failure = error._tag === 'Failure' ? error.cause.reasons[0].error : undefined
		expect(Schema.isSchemaError(failure)).toBe(true)
		expect(failure['~effect/Schema/SchemaError']).toBe('~effect/Schema/SchemaError')
	})
})
