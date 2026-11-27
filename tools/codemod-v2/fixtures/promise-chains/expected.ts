import { k } from 'cvx-kit'
import { Effect, pipe } from 'effect'

export const Payload = k.strictObject({ id: k.string() })

export async function load(request: Promise<Response>) {
	const body = await request.then((response) => response.json()).catch(() => null)
	return Payload.parse(body)
}

export const program = Effect.succeed(1).pipe(Effect.map((value) => value + 1))
export const piped = pipe(
	Effect.fail('x'),
	Effect.catchAll(() => Effect.succeed(0)),
)
export const stream = fetch('/x')
	.catch(() => null)
	.finally(() => undefined)
export const mapped = Promise.resolve([1])
	.then((list) => list.map((value) => value))
	.catch(String)
