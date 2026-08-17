// Convex's CLI discovers a packaged component only when its definition file
// is literally named `convex.config.js` (see DEFINITION_FILENAME_JS in the
// convex CLI). vp pack emits .mjs, so this postbuild step materializes the
// compiled definition as convex.config.js in each component's dist directory.
import {
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const component of ['foundation', 'approvals']) {
	const directory = join(root, 'dist', 'components', component)
	const config = readFileSync(join(directory, 'convex.config.mjs'), 'utf8')
		.replace(/\/\/# sourceMappingURL=.*\n?/, '')
	writeFileSync(join(directory, 'convex.config.js'), config)

	// Component implementations are discovered from schema.ts/schema.js only.
	// Keeping schema.mjs beside schema.js is also invalid because Convex
	// canonicalizes both extensions to the same module path.
	const schema = readFileSync(join(directory, 'schema.mjs'), 'utf8').replace(
		/\/\/# sourceMappingURL=.*\n?/,
		'',
	)
	writeFileSync(join(directory, 'schema.js'), schema)
	for (const filename of readdirSync(directory)) {
		if (!filename.endsWith('.mjs')) continue
		const path = join(directory, filename)
		const source = readFileSync(path, 'utf8')
		const bridged = source.replaceAll('./schema.mjs', './schema.js')
		if (bridged !== source) writeFileSync(path, bridged)
	}
	renameSync(join(directory, 'schema.d.mts'), join(directory, 'schema.d.ts'))
	const dataModelDeclaration = join(
		directory,
		'_generated',
		'dataModel.d.mts',
	)
	writeFileSync(
		dataModelDeclaration,
		readFileSync(dataModelDeclaration, 'utf8').replace(
			'../schema.mjs',
			'../schema.js',
		),
	)
	rmSync(join(directory, 'schema.mjs'))
	rmSync(join(directory, 'schema.mjs.map'))
	console.log(`bridged dist/components/${component}/convex.config.js`)
	console.log(`bridged dist/components/${component}/schema.js`)
}
