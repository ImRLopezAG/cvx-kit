import { z } from 'zod'
import { defineDomainContract } from '../src/contracts'
const contract = defineDomainContract({
	queries: { get: { input: z.number(), result: z.string() } },
})
// Handler drafts expose implementation settings, not unbound schema fields.
import type { DomainFactory } from '../src/modules/foundation/operation'
import type { DomainEffectFactory } from '../src/modules/effect/domain'
type NormalDraft = ReturnType<
	DomainFactory<{ actor: string }, typeof contract.queries, false, false>['query']['handler']
>
type EffectDraft = ReturnType<
	DomainEffectFactory<{ actor: string }, typeof contract.queries, false>['query']['handler']
>
declare const normalDraft: NormalDraft
declare const effectDraft: EffectDraft
// @ts-expect-error draft schemas are not installed before registration
void normalDraft.input
// @ts-expect-error draft schemas are not installed before registration
void effectDraft.result
