/* oxlint-disable anti-slop/no-runtime-typeof -- Benchmark worker reads untyped scenario exports. */
import assert from 'node:assert/strict'
import { Session } from 'node:inspector/promises'
import { pathToFileURL } from 'node:url'

const [, , bundle, scenario, allocations] = process.argv
const { setup } = await import(pathToFileURL(bundle).href)
const run = await setup(scenario)
const page = scenario.startsWith('page/')
const [, mode, size] = scenario.split('/')
const iterations = page ? (mode === 'relations' ? 5 : 12) : 500
const micros = () => performance.now() * 1000
let result
let warmResult

function check(value) {
	if (page || (scenario.startsWith('auth') && Number(size) > 1)) {
		assert.equal(value.page.length, Number(size), scenario)
		assert.equal(typeof value.continueCursor, 'string')
		if (page && ['zero', 'one', 'several', 'indexed'].includes(mode)) {
			const expected = []
			for (let id = 0; expected.length < Number(size); id++) {
				if (mode !== 'zero' && id % 3 !== 0) continue
				if ((mode === 'several' || mode === 'indexed') && (id < 100 || id % 2 || id % 7 === 0))
					continue
				expected.push(id)
			}
			assert.deepEqual(
				value.page.map((row) => row.amountCents),
				expected,
			)
		}
		if (page && mode === 'relations') {
			assert(value.page.every((row) => row.children.page.length === 1 && row.parent.parent))
		}
	} else if (scenario.startsWith('effect/')) assert.equal(value, 5)
	else if (scenario === 'plan/filter-scope') assert.match(value, /^[0-9a-f]{64}$/)
	else if (scenario === 'cursor/seal') assert.match(value, /^pc\.v1\.bench\./)
	else if (scenario === 'cursor/roundtrip') assert.equal(value, '["77",77,"bench-row-77"]')
	else assert.equal(value, 'one row')
}

await run(async (invoke, readCounts) => {
	globalThis.gc()
	const start = micros()
	result = await invoke()
	const firstUs = micros() - start
	check(result)
	const counts = readCounts?.()
	for (let i = 0; i < iterations; i++) warmResult = await invoke()
	check(warmResult)
	globalThis.gc()
	const warmStart = micros()
	for (let i = 0; i < iterations; i++) warmResult = await invoke()
	const warmUs = (micros() - warmStart) / iterations
	check(warmResult)
	let warmSampledBytes
	if (allocations) {
		const session = new Session()
		session.connect()
		try {
			await session.post('HeapProfiler.startSampling', {
				samplingInterval: 4096,
				includeObjectsCollectedByMajorGC: true,
				includeObjectsCollectedByMinorGC: true,
			})
			const samples = Math.min(256, iterations)
			for (let i = 0; i < samples; i++) warmResult = await invoke()
			const { profile } = await session.post('HeapProfiler.stopSampling')
			warmSampledBytes = profile.samples.reduce((bytes, item) => bytes + item.size, 0) / samples
		} finally {
			session.disconnect()
		}
	}
	console.log(JSON.stringify({ firstUs, warmUs, warmSampledBytes, counts }))
})
