import { z } from 'zod'

export const Catchall = z.strictObject({ a: z.string() }).catchall(z.string())
export const Recursive = z.lazy(() => z.string())
export const Pair = z.tuple([z.string(), z.number()])
export const Custom = z.custom<string>((value) => value === 'x')
export const Instance = z.instanceof(Date)
export const Super = z
	.string()
	.superRefine((value, ctx) => ctx.addIssue({ code: 'custom', message: value }))
export const Meta = z.string().meta({ title: 'x' })
export const Coerced = z.coerce.number()
export const Pre = z.preprocess((value) => value, z.string())
export const Codec = z.codec(z.string(), z.number(), { decode: Number, encode: String })
export const Branded = z.string().brand<'Id'>()
export const Frozen = z.strictObject({ a: z.string() }).readonly()
export const Upload = z.file()
export const Template = z.templateLiteral(['a', z.string()])
export const Time = z.iso.time()
export const Email = z.email()
export const Url = z.string().url()
export const Schema = z.toJSONSchema(z.string())
export type Any = z.ZodTypeAny
export const isZod = (value: Date) => value instanceof z.ZodType
export const Mystery = z.somethingNew()
export const definition = z.string().def
