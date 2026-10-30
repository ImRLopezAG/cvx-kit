import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { expect, test } from 'vite-plus/test'
import { getRelationMetadata, type RelationRegistryIdentity } from '../src/relations'
import { defineTables, register } from '../scripts/bench/relations-fixture'
import { groupDeclarations } from './fixture-querying/field-groups'
import { idUnionFixture } from './fixture-querying/id-unions'
import { largeRegistry } from './fixture-querying/large-registry'
import { relationshipFixture } from './fixture-querying/relationships'
import { searchDeclarations } from './fixture-querying/search'
import { variantEdgesFixture } from './fixture-querying/variant-edges'
import { variantFixture } from './fixture-querying/variants'

// Golden values were captured from the eager v0.1.24 registry. Cursors bind the
// SHA-256 of the identity, so any byte difference would orphan live cursors.
const golden = new URL('./relations-identity-golden.json', import.meta.url)

const registries: Record<string, () => RelationRegistryIdentity> = {
	bench: () => register(defineTables()),
	fieldGroups: () => groupDeclarations().relations,
	idUnions: () => idUnionFixture().relations,
	large: () => largeRegistry().relations,
	relationships: () => relationshipFixture().relations,
	search: () => searchDeclarations().relations,
	variantEdges: () => variantEdgesFixture().relations,
	variants: () => variantFixture().relations,
}

function digest(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

function capture(registry: RelationRegistryIdentity) {
	return {
		identity: digest(registry.identity),
		metadata: digest(JSON.stringify(getRelationMetadata(registry))),
	}
}

test('registry identity and metadata snapshots are byte-identical to the eager registry', () => {
	const actual = Object.fromEntries(
		Object.entries(registries).map(([name, create]) => [name, capture(create())]),
	)
	if (process.env.UPDATE_RELATION_GOLDEN) fs.writeFileSync(golden, `${JSON.stringify(actual, null, '\t')}\n`)
	const expected = JSON.parse(fs.readFileSync(golden, 'utf8'))
	expect(Object.keys(actual)).toEqual(Object.keys(expected))
	for (const name of Object.keys(expected)) {
		expect(actual[name].identity, name).toBe(expected[name].identity)
		expect(actual[name].metadata, name).toBe(expected[name].metadata)
	}
})
