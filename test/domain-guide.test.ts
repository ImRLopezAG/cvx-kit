import { readFileSync } from 'node:fs'
import { expect, it } from 'vite-plus/test'
it('keeps the documented public consumer example synchronized with its compile fixture', () => {
	const guide = readFileSync(new URL('../src/docs/domain-contracts.md', import.meta.url), 'utf8')
	const snippet = guide.split('```ts\n')[1].split('```')[0].trim()
	const fixture = readFileSync(new URL('./domain-contract-guide-types.ts', import.meta.url), 'utf8')
		.replaceAll('../src/index', 'cvx-kit')
		.replaceAll('../src/contracts', 'cvx-kit/contracts')
		.replaceAll('../src/errors', 'cvx-kit/errors')
		.trim()
	expect(snippet).toBe(fixture)
})
