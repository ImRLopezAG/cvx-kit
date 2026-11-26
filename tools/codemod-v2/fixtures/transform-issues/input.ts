import { z } from 'zod'

export const List = z.string().transform((text, ctx) => {
	if (text === '') {
		ctx.addIssue({ code: 'custom', message: 'Expected a list', path: ['text'] })
		return z.NEVER
	}
	return text.split(',')
})
export const Short = z.string().transform((text, ctx) => {
	if (text.length > 3) ctx.addIssue({ code: 'too_big', maximum: 3, origin: 'string', message: 'Too long' })
	return text
})
export const Aborting = z.string().transform((text, ctx) => {
	ctx.addIssue({ code: 'custom', message: 'no', fatal: true })
	return z.NEVER
})
export const Plain = z.string().transform((text) => text.length)
