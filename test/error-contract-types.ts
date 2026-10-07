import { z } from 'zod'
import { Cause } from 'effect'
import {
	defineErrorContract,
	type DeclaredError,
	type DecodedFailure,
} from '../src/modules/contracts/errors'
import { projectErrorCause } from '../src/modules/effect/errors'

const definitions = {
	NotFound: { message: 'Not found', details: { id: z.string() } },
	Conflict: { message: 'Conflict', details: { revision: z.number() } },
} as const
const contract = defineErrorContract(definitions)
const error = contract.create('NotFound', { id: '1' })
const code: 'NotFound' = error.code
const id: string = error.details.id
const server: DeclaredError<typeof definitions> = error
// @ts-expect-error Codes remain closed.
contract.create('Other', {})
// @ts-expect-error Detail types remain precise.
contract.create('NotFound', { id: 1 })
// @ts-expect-error Only allowlisted fields are accepted.
contract.create('NotFound', { id: '1', token: 'private' })
// @ts-expect-error Tag and shape cannot construct a trusted server error.
const forged: DeclaredError<typeof definitions> = {
	_tag: 'DeclaredError',
	code: 'NotFound',
	details: { id: '1' },
}

const decoded: DecodedFailure<typeof definitions> = contract.decode({})
const projected = projectErrorCause(contract, Cause.fail(server))
if (projected._tag === 'DeclaredFailure') {
	if (projected.code === 'NotFound') {
		const detail: string = projected.details.id
		// @ts-expect-error Narrowing the code narrows its correlated detail type.
		void projected.details.revision
		void detail
	} else {
		const detail: number = projected.details.revision
		void detail
	}
} else {
	// @ts-expect-error Unknown failures carry no private diagnostics or declared details.
	void projected.details
}
void [code, id, server, forged, decoded]
