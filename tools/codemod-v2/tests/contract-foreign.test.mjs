// @vitest-environment node
import { expect, it } from 'vite-plus/test'
import { transformSource } from '../transform.mjs'

it('rewrites every contract entry and shared local around one foreign field', () => {
	const source = `import { z } from 'zod'
import { defineDomainContract } from 'cvx-kit/contracts'
import { paginationOpts } from '@sdk/contracts'
const shared = z.string()
export const contract = defineDomainContract({ queries: {
  list: { input: z.object({ paginationOpts, name: shared }), result: z.array(shared) },
  get: { input: z.object({ id: shared }), result: shared }
} })`
	const result = transformSource('contract.ts', source)
	expect(result.status).toBe('rewritten')
	expect(result.output).toContain('const shared = k.string()')
	expect(result.output).toContain('input: k.object({ paginationOpts, name: shared })')
	expect(result.output).toContain('result: k.array(shared)')
	expect(result.output).toContain('input: k.object({ id: shared })')
	expect(result.declarations).toEqual({ rewritten: 2, left: 0 })
	expect(result.skipped.map(({ code, line, text }) => ({ code, line, text }))).toEqual([
		{ code: 'zod-foreign-schema', line: 6, text: 'paginationOpts' },
	])
	const second = transformSource('contract.ts', result.output)
	expect(second.output).toBe(result.output)
	expect(second.skipped.map(({ code, text }) => ({ code, text }))).toEqual([
		{ code: 'zod-foreign-schema', text: 'paginationOpts' },
	])
})

it.each(['args', 'returns'])(
	'rewrites siblings of foreign function %s through an alias and field map',
	(property) => {
		const source = `import { z } from 'zod'
import { effectZodApiBuilder } from 'cvx-kit/effect'
import { foreign } from '@sdk/contracts'
const query = effectZodApiBuilder(base, {})
const alias = foreign
const fields = { foreign: alias, name: z.string() }
const shared = z.boolean()
export const get = query({ ${property}: fields, ${property === 'args' ? 'returns' : 'args'}: z.object({ shared }), handler })`
		const result = transformSource('function.ts', source)
		expect(result.output).toContain('name: k.string()')
		expect(result.output).toContain('const shared = k.boolean()')
		expect(result.output).toContain('k.object({ shared })')
		expect(result.skipped.filter(({ code }) => code === 'zod-foreign-schema')).toHaveLength(1)
		expect(result.declarations.left).toBe(0)
		expect(transformSource('function.ts', result.output).output).toBe(result.output)
	},
)

it.each(['unproven', false, 'native'])(
	'reports a foreign contract result consumed by a %s function',
	(kind) => {
		const result = transformSource(
			'api.ts',
			`import { query } from './functions'
import { contract } from './contract'
export const get = query({ args: contract.queries.get.input, returns: contract.queries.get.result, handler })`,
			{
				run: {
					registrationKind: () => kind,
					isTable: () => false,
					isK: (_path, _source, name) => name === 'contract.queries.get.input',
				},
			},
		)
		expect(result.status).not.toBe('error')
		expect(result.skipped.map(({ code, text }) => ({ code, text }))).toEqual([
			{ code: 'zod-foreign-schema', text: 'contract.queries.get.result' },
		])
	},
)
