import type { VAny, VFloat64, VString } from 'convex/values'
import { k, type KIssue, type KSafeParseResult, type KValidationData } from '../src/k'

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

const plain = k.object({
	name: k
		.string()
		.trim()
		.toLowerCase()
		.min(1)
		.length(4)
		.overwrite((value) => value.trim()),
	tags: k.array(k.string()).optional(),
	kind: k.enum(['a', 'b']).nullable(),
})
const withDefault = k.object({ n: k.number().default(0) })
const length = k.string().transform((value) => value.length)
const piped = length.pipe(k.number().int())
const withTransform = k.object({ size: length, id: k.id('users') })
const refined = k
	.object({ from: k.number(), to: k.number() })
	.refine((value) => value.from < value.to, { path: ['to'] })
	.check((value, context) => {
		if (value.from < 0) context.addIssue({ path: ['from'], message: 'negative' })
	})

const assertions: [
	Assert<Equal<k.input<typeof plain>, k.output<typeof plain>>>,
	Assert<Equal<k.input<typeof refined>, k.output<typeof refined>>>,
	Assert<Equal<k.input<typeof withDefault>, { n?: number }>>,
	Assert<Equal<k.output<typeof withDefault>, { n: number }>>,
	Assert<Equal<k.input<typeof length>, string>>,
	Assert<Equal<k.output<typeof length>, number>>,
	Assert<Equal<k.output<typeof piped>, number>>,
	Assert<
		Equal<
			k.input<typeof withTransform>,
			{ size: string; id: k.infer<ReturnType<typeof k.id<'users'>>> }
		>
	>,
	Assert<Equal<k.output<typeof withTransform>['size'], number>>,
	Assert<Equal<typeof length.validator, VString<string>>>,
	Assert<Equal<typeof length.outputValidator, VAny<number>>>,
	Assert<Equal<typeof piped.outputValidator, VFloat64<number>>>,
	Assert<Equal<(typeof withTransform)['_t'], true>>,
	Assert<Equal<(typeof plain)['_t'], false>>,
	Assert<Equal<(typeof withDefault)['_t'], false>>,
	Assert<Equal<ReturnType<typeof plain.parse>, k.output<typeof plain>>>,
	Assert<Equal<ReturnType<typeof length.safeParse>, KSafeParseResult<number>>>,
	Assert<Equal<KValidationData['issues'], KIssue[]>>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
]
void assertions

const result = length.safeParse('x')
if (result.success) {
	const data: number = result.data
	void data
} else {
	const issues: KIssue[] = result.issues
	void issues
}

// @ts-expect-error a string check is not available after a transform to number
length.min(1)
// @ts-expect-error overwrite keeps the type
k.string().overwrite((value) => value.length)
// @ts-expect-error a refinement reads the parsed value's type
k.number().refine((value: string) => value.length > 0)
