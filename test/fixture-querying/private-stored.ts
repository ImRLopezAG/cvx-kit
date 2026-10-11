import { z } from 'zod'
import { defineSchema } from 'convex/server'
import { defineTestApp } from 'convex-test'
import { zodTable } from '../../src/zod-table'
import { defineRelations } from '../../src/relations'
import { createQueryEngine } from '../../src/querying'
import { cursor } from './scalar'

export function privateStoredFixture() {
	const calls = { transform: 0, default: 0, coercion: 0 }
	const numeric = z.number().transform((value) => {
		calls.transform++
		return value + 1000
	})
	const text = z.string().transform(() => {
		calls.transform++
		return 'transformed'
	})
	const fallback = z.string().default(() => {
		calls.default++
		return 'defaulted'
	})
	const coerced = z.coerce.number().refine(() => {
		calls.coercion++
		return true
	})
	const tasks = zodTable(
		'tasks',
		() => ({ title: z.string(), numeric, text, fallback: fallback.optional(), coerced }),
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

export function privatePrefaultFixture() {
	const calls = { prefault: 0 }
	const fallback = () => {
		calls.prefault++
		throw new Error('Private prefault invoked')
	}
	const output = z.string().prefault(fallback)
	// @ts-expect-error installed .pipe rejects prefault's wider input; every string is accepted at runtime.
	const hidden = z.string().pipe<typeof output>(output)
	const nestedOutput = z.object({ code: z.string().prefault(fallback) })
	const nestedInput = z.object({ code: z.string() })
	// @ts-expect-error same installed variance restriction on the nested prefault input.
	const nested = nestedInput.pipe<typeof nestedOutput>(nestedOutput)
	const tasks = zodTable('tasks', () => ({ title: z.string(), hidden, nested }), {
		publicFields: ['title'],
	})
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
