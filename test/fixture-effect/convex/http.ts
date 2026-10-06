import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'

const http = httpRouter()
http.route({
	path: '/effect-fixture',
	method: 'GET',
	handler: httpAction(async () => new Response('fixture-http-ok', { status: 200 })),
})
export default http
