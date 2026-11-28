import { k } from '../../src/k'
import { defineSchema } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { kTable } from '../../src/table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor } from './scalar'

/**
 * Stored fields that declare behaviour (normalisers, defaults, checks) the engine must never run:
 * queries read stored values natively and only the public DTO is parsed. v2 tables reject transforms
 * and pipes outright (KTD4), so the normalisers stand where v1 used transforms and coercion.
 */
export function privateStoredFixture() {
	const calls = { transform: 0, default: 0, coercion: 0 }
	const numeric = k.number().overwrite((value) => {
		calls.transform++
		return value + 1000
	})
	const text = k.string().overwrite(() => {
		calls.transform++
		return 'transformed'
	})
	const fallback = k
		.string()
		.refine(() => {
			calls.default++
			return true
		})
		.default('defaulted')
	const coerced = k.number().refine(() => {
		calls.coercion++
		return true
	})
	const tasks = kTable(
		'tasks',
		{ title: k.string(), numeric, text, fallback, coerced },
		{
			publicFields: ['title'],
		},
	)
	const nativeTasks = tasks.table.index('by_numeric', ['numeric']).index('by_text', ['text'])
	const relations = defineRelations({ tasks }, () => ({}))
	const schema = defineSchema({ tasks: nativeTasks })
	const { createTest } = defineTestApp({ schema }).defineModules({})
	return {
		calls,
		tasks,
		numeric,
		text,
		fallback,
		coerced,
		relations,
		schema,
		t: createTest(),
		querying: createQueryEngine({ schema, relations, cursor }),
	}
}

/** Private stored fields whose declared checks must never run during a query (v1 used prefaults). */
export function privatePrefaultFixture() {
	const calls = { prefault: 0 }
	function fallback(): boolean {
		calls.prefault++
		throw new Error('Private prefault invoked')
	}
	const output = k.string().refine(fallback)
	const hidden = output
	const nestedOutput = k.object({ code: k.string().refine(fallback) })
	const nested = nestedOutput
	const tasks = kTable(
		'tasks',
		{ title: k.string(), hidden, nested },
		{
			publicFields: ['title'],
		},
	)
	const nativeTasks = tasks.table.index('by_hidden', ['hidden'])
	const relations = defineRelations({ tasks }, () => ({}))
	const schema = defineSchema({ tasks: nativeTasks })
	const { createTest } = defineTestApp({ schema }).defineModules({})
	return {
		calls,
		output,
		hidden,
		nestedOutput,
		nested,
		tasks,
		relations,
		schema,
		t: createTest(),
		querying: createQueryEngine({ schema, relations, cursor }),
	}
}
