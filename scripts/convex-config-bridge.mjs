// Convex's CLI discovers a packaged component only when its definition file
// is literally named `convex.config.js` (see DEFINITION_FILENAME_JS in the
// convex CLI). vp pack emits .mjs, so this postbuild step materializes the
// compiled definition as convex.config.js in each component's dist directory.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const component of ['foundation', 'approvals']) {
	const directory = join(root, 'dist', 'components', component)
	const compiled = readFileSync(join(directory, 'convex.config.mjs'), 'utf8')
		.replace(/\/\/# sourceMappingURL=.*\n?/, '')
	writeFileSync(join(directory, 'convex.config.js'), compiled)
	console.log(`bridged dist/components/${component}/convex.config.js`)
}
