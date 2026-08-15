import { describe, expect, it } from 'vite-plus/test'

import { KitError } from '../src/errors'
import { createStateMachine } from '../src/state-machine'

const DOCUMENT_STATES = ['draft', 'published', 'archived'] as const

describe('createStateMachine', () => {
	const machine = createStateMachine(DOCUMENT_STATES, {
		draft: ['published', 'archived'],
		published: ['archived'],
	})

	it('permits legal transitions and rejects illegal ones', () => {
		expect(machine.can('draft', 'published')).toBe(true)
		expect(machine.can('published', 'draft')).toBe(false)
		machine.assert('draft', 'archived')
		expect(() => machine.assert('published', 'draft')).toThrow(KitError)
		expect(() => machine.assert('published', 'draft')).toThrow(
			/INVALID_TRANSITION|not legal/,
		)
	})

	it('a state with no outgoing transitions rejects everything', () => {
		expect(machine.can('archived', 'draft')).toBe(false)
		expect(machine.can('archived', 'published')).toBe(false)
	})

	it('routes through a custom ErrorFactory', () => {
		const codes: string[] = []
		const custom = createStateMachine(DOCUMENT_STATES, { draft: [] }, {
			errors: {
				throw: (input) => {
					codes.push(input.code)
					throw new Error(`custom:${input.code}`)
				},
			},
		})
		expect(() => custom.assert('draft', 'published')).toThrow(
			'custom:INVALID_TRANSITION',
		)
		expect(codes).toEqual(['INVALID_TRANSITION'])
	})

	it('type-level: transition literals outside the tuple do not compile', () => {
		createStateMachine(DOCUMENT_STATES, {
			// @ts-expect-error 'deleted' is not in the vocabulary
			draft: ['deleted'],
		})
		createStateMachine(DOCUMENT_STATES, {
			// @ts-expect-error 'pending' is not a state key
			pending: ['draft'],
		})
	})
})
