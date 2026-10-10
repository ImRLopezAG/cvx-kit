import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temporary = mkdtempSync(join(tmpdir(), 'cvx-kit-auth-'))
function run(command, args, cwd) {
	try {
		return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' })
	} catch (error) {
		if (!args.includes('install')) {
			process.stderr.write(error.stdout ?? '')
			process.stderr.write(error.stderr ?? '')
		}
		throw new Error(`${command} ${args.join(' ')} failed in ${basename(cwd)}`, {
			cause: error.code,
		})
	}
}
try {
	run('bun', ['pm', 'pack', '--ignore-scripts', '--destination', temporary], root)
	const tarball = join(temporary, `${manifest.name}-${manifest.version}.tgz`)
	// 1.45 is a declaration regression target, below the current workflow peer floor.
	for (const convex of ['1.45.0', '1.46.0']) {
		const fixture = mkdtempSync(join(temporary, `convex-${convex}-`))
		writeFileSync(
			join(fixture, 'package.json'),
			JSON.stringify({
				private: true,
				type: 'module',
				dependencies: {
					'cvx-kit': `file:${tarball}`,
					convex,
					'convex-helpers': manifest.devDependencies['convex-helpers'],
					effect: manifest.devDependencies.effect,
					zod: manifest.devDependencies.zod,
					typescript: manifest.devDependencies.typescript,
					'@types/node': manifest.devDependencies['@types/node'],
				},
			}),
		)
		writeFileSync(
			join(fixture, 'auth.ts'),
			readFileSync(join(root, 'test/auth-native-context-types.ts')),
		)
		writeFileSync(
			join(fixture, 'shared-auth.ts'),
			readFileSync(join(root, 'test/effect-auth-types.ts')),
		)
		writeFileSync(
			join(fixture, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					target: 'ES2025',
					module: 'ESNext',
					moduleResolution: 'bundler',
				},
				include: ['auth.ts', 'shared-auth.ts'],
			}),
		)
		run('bun', ['install', '--ignore-scripts'], fixture)
		run('bun', ['x', '--no-install', 'tsc', '--project', 'tsconfig.json'], fixture)
		console.log(`Packed auth native contexts pass on Convex ${convex}`)
	}
} finally {
	rmSync(temporary, { recursive: true, force: true })
}
