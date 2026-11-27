import type { Validator } from 'convex/values'
import type { KType } from '../src/k'
import { k } from '../src/k'

// Long derivation chains must retain all fields without exhausting type depth.
const chained = k
	.object({ start: k.string() })
	.extend({ f0: k.number() })
	.extend({ f1: k.number() })
	.extend({ f2: k.number() })
	.extend({ f3: k.number() })
	.extend({ f4: k.number() })
	.extend({ f5: k.number() })
	.extend({ f6: k.number() })
	.extend({ f7: k.number() })
	.extend({ f8: k.number() })
	.extend({ f9: k.number() })
	.extend({ f10: k.number() })
	.extend({ f11: k.number() })
	.extend({ f12: k.number() })
	.extend({ f13: k.number() })
	.extend({ f14: k.number() })
	.extend({ f15: k.number() })
	.extend({ f16: k.number() })
	.extend({ f17: k.number() })
	.extend({ f18: k.number() })
	.extend({ f19: k.number() })
	.extend({ f20: k.number() })
	.extend({ f21: k.number() })
	.extend({ f22: k.number() })
	.extend({ f23: k.number() })
	.extend({ f24: k.number() })
	.extend({ f25: k.number() })
	.extend({ f26: k.number() })
	.extend({ f27: k.number() })
	.extend({ f28: k.number() })
	.extend({ f29: k.number() })
	.extend({ f30: k.number() })
	.extend({ f31: k.number() })
	.extend({ f32: k.number() })
	.extend({ f33: k.number() })
	.extend({ f34: k.number() })
	.extend({ f35: k.number() })
	.extend({ f36: k.number() })
	.extend({ f37: k.number() })
	.extend({ f38: k.number() })
	.extend({ f39: k.number() })

const n0 = k.object({ start: k.string() })
const n1 = n0.extend({ n1: k.object({ b: n0 }) })
const n2 = n1.extend({ n2: k.object({ b: n1 }) })
const n3 = n2.extend({ n3: k.object({ b: n2 }) })
const n4 = n3.extend({ n4: k.object({ b: n3 }) })
const n5 = n4.extend({ n5: k.object({ b: n4 }) })
const n6 = n5.extend({ n6: k.object({ b: n5 }) })
const n7 = n6.extend({ n7: k.object({ b: n6 }) })
const n8 = n7.extend({ n8: k.object({ b: n7 }) })
const n9 = n8.extend({ n9: k.object({ b: n8 }) })
const n10 = n9.extend({ n10: k.object({ b: n9 }) })
const n11 = n10.extend({ n11: k.object({ b: n10 }) })
const n12 = n11.extend({ n12: k.object({ b: n11 }) })
const n13 = n12.extend({ n13: k.object({ b: n12 }) })
const n14 = n13.extend({ n14: k.object({ b: n13 }) })
const n15 = n14.extend({ n15: k.object({ b: n14 }) })
const n16 = n15.extend({ n16: k.object({ b: n15 }) })
// Native field paths double at every link; 15 links pass, 16 exceed the union limit.
const withinLimit = k.strictObject({ field: n15.extend({ kind: k.literal('a') }) })
// @ts-expect-error Sixteen branching links exceed TypeScript's native field-path union limit (TS2590).
const nested = k.strictObject({ field: n16.extend({ kind: k.literal('a') }) })
// @ts-expect-error The same sixteen-link limit applies to inline union members (TS2590).
const nestedUnion = k.union([n16.extend({ kind: k.literal('a') }), k.null()])

// An explicit validator boundary preserves parsed values but widens native field paths.
interface Boundary extends KType {
	readonly _output: k.infer<typeof n15>
	readonly _req: Validator<k.infer<typeof n15>, 'required', string>
	readonly validator: Validator<k.infer<typeof n15>, 'required', string>
	readonly _d: false
	readonly _t: false
}
const boundary: Boundary = n15
const bounded = n15.extend({ n16: k.object({ b: boundary }) })
const boundedInline = k.strictObject({ field: bounded.extend({ kind: k.literal('a') }) })

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const assertions: [
	Assert<Equal<k.infer<typeof chained>['start'], string>>,
	Assert<Equal<k.infer<typeof chained>['f0' | 'f39'], number>>,
	Assert<Equal<k.infer<typeof bounded>, k.infer<typeof n16>>>,
] = [true, true, true]
void assertions
void [chained, withinLimit, nested, nestedUnion, boundedInline]
