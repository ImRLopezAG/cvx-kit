import { z } from 'zod'
import { kTable, k } from 'cvx-kit'

const fieldsFor = (id: (table: string) => z.ZodString) => ({ owner: id('users') })

export const complex = kTable('complex', (id) => {
	const owner = id('users')
	return { owner }
})

export const passed = kTable('passed', (id) => fieldsFor(id))

export const simple = kTable('simple', { owner: k.id('users') })
