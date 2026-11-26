import { z } from 'zod'
import { k } from 'cvx-kit'

export const List = k.string().transform((text, ctx) => {
	if (text === '') {
		ctx.addIssue({ code: 'custom', message: 'Expected a list', path: ['text'] })
		return k.NEVER
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
export const Plain = k.string().transform((text) => text.length)
