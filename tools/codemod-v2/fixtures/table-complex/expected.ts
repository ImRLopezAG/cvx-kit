import { z } from 'zod'
import { zodTable, kTable, k } from 'cvx-kit'

const fieldsFor = (id: (table: string) => z.ZodString) => ({ owner: id('users') })

export const complex = kTable('complex', (() => {
	const owner = k.id('users')
	return { owner }
})())

export const passed = zodTable('passed', (id) => fieldsFor(id))

export const simple = kTable('simple', { owner: k.id('users') })
