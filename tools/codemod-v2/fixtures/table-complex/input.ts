import { z } from 'zod'
import { zodTable } from 'cvx-kit'

const fieldsFor = (id: (table: string) => z.ZodString) => ({ owner: id('users') })

export const complex = zodTable('complex', (id) => {
	const owner = id('users')
	return { owner }
})

export const passed = zodTable('passed', (id) => fieldsFor(id))

export const simple = zodTable('simple', (id) => ({ owner: id('users') }))
