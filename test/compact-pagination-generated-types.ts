import type { FunctionArgs } from 'convex/server'
import type { GenericId } from 'convex/values'
import type { PaginationFiltersInput } from 'cvx-kit/relations'
import { api } from './fixture-compact-pagination/api-only'
import type {
	scalarOptions,
	idOptions,
	variantIdOptions,
} from './fixture-compact-pagination/convex/tables'

type IsAny<T> = 0 extends 1 & T ? true : false
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type NotAny<T> = Equal<IsAny<T>, false>
type Scalar = FunctionArgs<typeof api.functions.scalar>
type Root = NonNullable<Scalar['filters']>
type Edge = NonNullable<Root['not']>
type Stage =
	| 's0'
	| 's1'
	| 's2'
	| 's3'
	| 's4'
	| 's5'
	| 's6'
	| 's7'
	| 's8'
	| 's9'
	| 's10'
	| 's11'
	| 's12'
type StageOps = Extract<NonNullable<Root['lifecycleStage']>, object>
type EdgeOps = Extract<NonNullable<Edge['lifecycleStage']>, object>
type Relation = NonNullable<FunctionArgs<typeof api.functions.relation>['filters']>
type Many = NonNullable<Relation['contacts']>
type Some = Extract<Many, { some: object }>['some']
type Variant = NonNullable<Relation['variant']>
type A = Extract<Variant, { tag: 'a' }>['filters']
type B = Extract<Variant, { tag: 'b' }>['filters']
type RelationEdge = NonNullable<Relation['not']>
type IdArgs = FunctionArgs<typeof api.functions.idHeavy>
type IdRoot = NonNullable<IdArgs['filters']>
export type CommonLevelProofs = [
	Assert<NotAny<Scalar>>,
	Assert<NotAny<Root>>,
	Assert<NotAny<Edge>>,
	Assert<NotAny<Root['lifecycleStage']>>,
	Assert<NotAny<Edge['lifecycleStage']>>,
	Assert<Equal<Extract<Root['lifecycleStage'], string>, Stage>>,
	Assert<Equal<Extract<Edge['lifecycleStage'], string>, Stage>>,
	Assert<Equal<StageOps['gte'], Stage | undefined>>,
	Assert<Equal<EdgeOps['in'], Stage[] | undefined>>,
	Assert<Equal<keyof StageOps, 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte'>>,
	Assert<Equal<keyof EdgeOps, keyof StageOps>>,
	Assert<
		Equal<keyof Root, 'status' | 'lifecycleStage' | 'email' | 'fields' | 'and' | 'or' | 'not'>
	>,
	Assert<Equal<keyof Edge, keyof Root>>,
	Assert<NotAny<NonNullable<Root['fields']>>>,
	Assert<NotAny<NonNullable<Edge['fields']>>>,
	Assert<Equal<Extract<NonNullable<Root['fields']>['lifecycleStage'], string>, Stage>>,
	Assert<Equal<Extract<NonNullable<Edge['fields']>['email'], string>, string>>,
	Assert<NotAny<NonNullable<Root['and']>[number]>>,
	Assert<NotAny<NonNullable<Root['or']>[number]>>,
	Assert<NotAny<Many>>,
	Assert<NotAny<Some>>,
	Assert<Equal<Extract<Some['email'], string>, string>>,
	Assert<NotAny<Relation>>,
	Assert<NotAny<RelationEdge>>,
	Assert<NotAny<Variant>>,
	Assert<Equal<Variant['tag'], 'a' | 'b'>>,
	Assert<NotAny<A>>,
	Assert<NotAny<B>>,
	Assert<Equal<Extract<A['subject'], string>, string>>,
	Assert<Equal<Extract<B['amount'], number>, number>>,
	Assert<Equal<'amount' extends keyof A ? true : false, false>>,
	Assert<Equal<'subject' extends keyof B ? true : false, false>>,
	Assert<NotAny<NonNullable<Relation['contact']>>>,
	Assert<Equal<Extract<NonNullable<Relation['contact']>['email'], string>, string>>,
	Assert<NotAny<NonNullable<RelationEdge['variant']>>>,
	Assert<Equal<Extract<RelationEdge['status'], string>, Stage>>,
	Assert<NotAny<IdRoot['owner']>>,
	Assert<Equal<Extract<IdRoot['owner'], string>, GenericId<'users'>>>,
	Assert<Equal<keyof Exclude<NonNullable<IdRoot['owner']>, string>, 'eq' | 'in'>>,
]

declare function scalar(value: Scalar): void
scalar({
	numItems: 1,
	cursor: null,
	filters: {
		lifecycleStage: { gte: 's2', in: ['s12'] },
		fields: { email: 'x' },
		not: { lifecycleStage: { lt: 's4' } },
	},
})
// @ts-expect-error actual generated root rejects unknown fields
scalar({ numItems: 1, cursor: null, filters: { unknown: 'x' } })
// @ts-expect-error actual generated first edge rejects unknown fields
scalar({ numItems: 1, cursor: null, filters: { not: { unknown: 'x' } } })
// @ts-expect-error generated literal union stays exact at root
scalar({ numItems: 1, cursor: null, filters: { lifecycleStage: 'invalid' } })
// @ts-expect-error generated literal union stays exact at first edge
scalar({ numItems: 1, cursor: null, filters: { and: [{ lifecycleStage: { gte: 'invalid' } }] } })
// @ts-expect-error generated scalar type stays exact
scalar({ numItems: 1, cursor: null, filters: { not: { fields: { email: 42 } } } })
// @ts-expect-error generated operators stay exact
scalar({ numItems: 1, cursor: null, filters: { lifecycleStage: { contains: 's1' } } })
// @ts-expect-error generated first-edge field namespace rejects unknown fields
scalar({ numItems: 1, cursor: null, filters: { not: { fields: { unknown: 'x' } } } })
// @ts-expect-error generated first-edge operators remain exact
scalar({ numItems: 1, cursor: null, filters: { not: { lifecycleStage: { contains: 's1' } } } })
// @ts-expect-error selected fields namespace stays exact
scalar({ numItems: 1, cursor: null, filters: { fields: { unknown: 'x' } } })
declare function relation(value: FunctionArgs<typeof api.functions.relation>): void
relation({
	numItems: 1,
	cursor: null,
	filters: { contact: { email: 'x' }, variant: { tag: 'a', filters: { subject: 'x' } } },
})
// @ts-expect-error actual generated relation target rejects unknown fields
relation({ numItems: 1, cursor: null, filters: { contact: { unknown: 'x' } } })
// @ts-expect-error actual generated variant tag determines selected fields
relation({ numItems: 1, cursor: null, filters: { variant: { tag: 'a', filters: { amount: 4 } } } })
// @ts-expect-error actual generated variant tag remains a literal union
relation({ numItems: 1, cursor: null, filters: { variant: { tag: 'missing', filters: {} } } })

// The full input helper admits input strings. Assignability to native arguments
// additionally requires the actual native table brand, retained by inference here.
declare const userId: GenericId<'users'>
declare const contactId: GenericId<'contacts'>
const scalarDepth4 = {
	not: { not: { not: { not: { lifecycleStage: 's1' } } } },
} satisfies PaginationFiltersInput<typeof scalarOptions>
const idDepth4 = {
	not: { not: { not: { not: { owner: { in: [userId] }, fields: { mixed: 'plain-mixed' } } } } },
} satisfies PaginationFiltersInput<typeof idOptions>
const variantDepth4 = {
	not: { not: { not: { variant: { tag: 'a', filters: { contactId } } } } },
} satisfies PaginationFiltersInput<typeof variantIdOptions>
const generatedScalar: Scalar = { numItems: 1, cursor: null, filters: scalarDepth4 }
const generatedIds: IdArgs = { numItems: 1, cursor: null, filters: idDepth4 }
const generatedVariant: FunctionArgs<typeof api.functions.variantIds> = {
	numItems: 1,
	cursor: null,
	filters: variantDepth4,
}
declare function nativeIds(value: IdArgs): void
const unbrandedAtDepth4 = { not: { not: { not: { not: { owner: 'plain-string' } } } } }
// @ts-expect-error generated native IDs cannot accept unbranded strings, even at depth four
nativeIds({ numItems: 1, cursor: null, filters: unbrandedAtDepth4 })
// @ts-expect-error table-specific brand remains exact
nativeIds({ numItems: 1, cursor: null, filters: { owner: contactId } })
const plainInput = {
	not: { not: { not: { not: { owner: 'plain-input-string' } } } },
} satisfies PaginationFiltersInput<typeof idOptions>
// @ts-expect-error the full input alias is intentionally broader than generated native ID arguments
nativeIds({ numItems: 1, cursor: null, filters: plainInput })
void [generatedScalar, generatedIds, generatedVariant]
