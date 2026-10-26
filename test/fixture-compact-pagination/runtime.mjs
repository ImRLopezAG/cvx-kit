import assert from 'node:assert/strict'

export async function prove({ url, admin, raw, seededIds, baseline = false }) {
	const identity = Buffer.from(
		JSON.stringify({ subject: 'u5', issuer: 'https://u5.invalid', org_id: 'u5', role: 'reader' }),
	).toString('base64')
	async function request(
		name,
		filters,
		accept,
		kind = 'query',
		args = { numItems: 1, cursor: null, filters },
	) {
		const r = await fetch(url + '/api/' + kind, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Convex ' + admin + ':' + identity,
			},
			body: JSON.stringify({
				path: 'functions:' + name,
				format: 'convex_encoded_json',
				args: [args],
			}),
			signal: AbortSignal.timeout(20000),
		})
		const body = await r.json()
		raw.push({ name, kind, args, accept, httpStatus: r.status, body })
		assert.equal(body.status, accept ? 'success' : 'error', name + ': ' + JSON.stringify(body))
		const logs = (body.logLines ?? []).join('\n')
		if (accept && name !== 'seed') {
			assert.equal(body.value, 'accepted')
			assert.match(logs, /U5_HANDLER/)
			if (name !== 'system') {
				assert.match(logs, /U5_CUSTOMIZATION/)
				assert.match(logs, /U5_ROLE/)
			}
		} else if (!accept) {
			assert.doesNotMatch(
				logs,
				/U5_(?:CUSTOMIZATION|ROLE|HANDLER)/,
				'invalid input reached user work',
			)
		}
		return body.value
	}
	const ids = seededIds
	assert.ok(ids.user && ids.contact && ids.user !== ids.contact)
	// The exact base retains native ID and mixed-union acceptance. Compact-only
	// pre-customization semantic timing is characterized separately below.
	if (baseline) {
		const nested = (n, value) => (n ? { not: nested(n - 1, value) } : value)
		for (const [name, kind] of [
			['idHeavy', 'query'],
			['mutate', 'mutation'],
			['act', 'action'],
			['system', 'query'],
		]) {
			for (let depth = 0; depth <= 4; depth++) {
				await request(name, nested(depth, { owner: ids.user }), true, kind)
				await request(name, nested(depth, { owner: ids.contact }), false, kind)
				await request(name, nested(depth, { mixed: ids.contact }), true, kind)
				await request(name, nested(depth, { mixed: 'unbranded-synthetic-string' }), true, kind)
			}
		}
		return
	}
	const nested = (n, value) => (n ? { not: nested(n - 1, value) } : value)
	for (const value of [
		{
			not: {
				not: {
					not: {
						not: { lifecycleStage: { gte: 's1', in: ['s2'] }, fields: { email: 'synthetic' } },
					},
				},
			},
		},
		{ and: Array(254).fill({}) },
		{ status: { in: Array(100).fill('synthetic') } },
	])
		await request('scalar', value, true)
	for (const value of [
		nested(5, {}),
		{ and: Array(255).fill({}) },
		{ status: { in: Array(101).fill('synthetic') } },
		nested(2, { unknown: 'bad' }),
		nested(2, { lifecycleStage: 'bad' }),
		nested(2, { email: 4 }),
		nested(2, { status: {} }),
		nested(2, { fields: { unknown: 'bad' } }),
	])
		await request('scalar', value, false)
	await request('relation', nested(3, { contact: { email: 'synthetic' } }), true)
	for (const operator of ['some', 'none']) {
		await request('relation', nested(3, { contacts: { [operator]: { email: 'synthetic' } } }), true)
		await request('relation', nested(2, { contacts: { [operator]: { unknown: 'bad' } } }), false)
	}
	await request('relation', { contacts: { some: {}, none: {} } }, false)
	await request(
		'relation',
		nested(3, { variant: { tag: 'a', filters: { subject: 'synthetic' } } }),
		true,
	)
	for (const value of [
		nested(2, { contact: { unknown: 'bad' } }),
		nested(2, { variant: { tag: 'a', filters: { amount: 3 } } }),
		nested(2, { variant: { tag: 'unknown', filters: {} } }),
	])
		await request('relation', value, false)
	for (const [name, kind] of [
		['idHeavy', 'query'],
		['mutate', 'mutation'],
		['act', 'action'],
		['system', 'query'],
	]) {
		for (const op of ['and', 'or']) {
			await request(name, { [op]: [nested(3, { owner: { in: [ids.user] } })] }, true, kind)
			await request(name, { [op]: [nested(3, { owner: { in: [ids.contact] } })] }, false, kind)
		}
		for (let depth = 0; depth <= 4; depth++) {
			for (const wrap of [
				(v) => ({ owner: v }),
				(v) => ({ owner: { eq: v } }),
				(v) => ({ owner: { in: [v] } }),
				(v) => ({ fields: { owner: v } }),
				(v) => ({ fields: { owner: { in: [v] } } }),
			]) {
				await request(name, nested(depth, wrap(ids.user)), true, kind)
				await request(name, nested(depth, wrap(ids.contact)), false, kind)
			}
			await request(name, nested(depth, { mixed: ids.contact }), true, kind)
			await request(name, nested(depth, { mixed: 'unbranded-synthetic-string' }), true, kind)
		}
		for (const value of [
			nested(2, { unknown: 'bad' }),
			nested(2, { owner: { gt: ids.user } }),
			nested(5, { owner: ids.user }),
		])
			await request(name, value, false, kind)
	}
	for (let depth = 0; depth <= 3; depth++) {
		for (const tag of ['a', 'b']) {
			for (const wrap of [
				(v) => ({ contactId: v }),
				(v) => ({ contactId: { eq: v } }),
				(v) => ({ contactId: { in: [v] } }),
				(v) => ({ fields: { contactId: v } }),
			]) {
				await request(
					'variantIds',
					nested(depth, { variant: { tag, filters: wrap(ids.contact) } }),
					true,
				)
				await request(
					'variantIds',
					nested(depth, { variant: { tag, filters: wrap(ids.user) } }),
					false,
				)
			}
		}
		for (const wrap of [
			(v) => ({ owner: v }),
			(v) => ({ owner: { eq: v } }),
			(v) => ({ fields: { owner: { in: [v] } } }),
		]) {
			await request('variantIds', nested(depth, { contact: wrap(ids.user) }), true)
			await request('variantIds', nested(depth, { contact: wrap(ids.contact) }), false)
			for (const operator of ['some', 'none']) {
				await request(
					'variantIds',
					nested(depth, { contacts: { [operator]: wrap(ids.user) } }),
					true,
				)
				await request(
					'variantIds',
					nested(depth, { contacts: { [operator]: wrap(ids.contact) } }),
					false,
				)
			}
		}
	}
}
