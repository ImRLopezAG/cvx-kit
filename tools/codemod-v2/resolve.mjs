import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, matchesGlob, relative, resolve, sep } from 'node:path'
import { ResolverFactory } from 'oxc-resolver'

/** Modules that are Zod, the kit or Convex itself: a call into them never hands a schema to another library. */
export const KIT_OR_ZOD_MODULE = /^(?:zod(?:\/|$)|cvx-kit(?:\/|$)|convex(?:-helpers)?(?:\/|$))/

/**
 * Resolve an import to the app's source, returning a cwd-relative path or null.
 * This also resolves files outside the scanned set: callers must separately check
 * whether the run actually learned facts about the returned file.
 */
export function createSourceResolver(cwd = process.cwd()) {
	const root = realpathSync(resolve(cwd))
	const resolvers = new Map()
	const cache = new Map()
	let workspaces
	const sourceResolver = (directory) => {
		let config = directory
		while (!existsSync(join(config, 'tsconfig.json'))) {
			if (dirname(config) === config) {
				config = null
				break
			}
			config = dirname(config)
		}
		const configFile = config ? join(config, 'tsconfig.json') : null
		if (!resolvers.has(configFile)) {
			const options = {
				symlinks: false,
				extensions: ['.ts', '.tsx', '.mts'],
				extensionAlias: { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.jsx': ['.tsx'] },
				modules: [],
			}
			if (configFile) options.tsconfig = { configFile }
			resolvers.set(configFile, new ResolverFactory(options))
		}
		return resolvers.get(configFile)
	}
	return (fromPath, specifier) => {
		const key = `${fromPath}\0${specifier}`
		if (cache.has(key)) return cache.get(key)
		const directory = dirname(resolve(root, fromPath))
		const resolver = sourceResolver(directory)
		let target = resolver.sync(directory, specifier).path
		if (!target && !specifier.startsWith('.') && !specifier.startsWith('/')) {
			workspaces ??= workspacePackages(root)
			for (const { directory: packageDirectory, manifest } of workspaces) {
				if (specifier !== manifest.name && !specifier.startsWith(`${manifest.name}/`)) continue
				const subpath = specifier.slice(manifest.name.length)
				for (const entry of packageEntries(manifest, subpath)) {
					target = resolver.sync(packageDirectory, resolve(packageDirectory, entry)).path
					if (isSource(target)) break
				}
				if (isSource(target)) break
			}
		}
		const result = isSource(target) ? relative(root, realpathSync(target)) : null
		cache.set(key, result)
		return result
	}
}

function isSource(path) {
	return Boolean(
		path &&
		!path.split(sep).includes('node_modules') &&
		/\.(?:ts|tsx|mts)$/.test(path) &&
		!/\.d\.(?:ts|mts)$/.test(path),
	)
}

function workspacePackages(root) {
	const packages = []
	const visitRoot = (directory) => {
		const manifestPath = join(directory, 'package.json')
		const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
		const patterns = Array.isArray(manifest.workspaces)
			? manifest.workspaces
			: (manifest.workspaces?.packages ?? [])
		const yaml = join(directory, 'pnpm-workspace.yaml')
		if (existsSync(yaml)) {
			const block =
				readFileSync(yaml, 'utf8').match(/^packages:\s*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? ''
			for (const line of block.split('\n')) {
				const pattern = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)?.[1]
				if (pattern) patterns.push(pattern.trim())
			}
		}
		if (patterns.length === 0) return
		const walk = (path) => {
			const local = relative(directory, path).split(sep).join('/')
			if (
				patterns.some((pattern) => !pattern.startsWith('!') && matchesGlob(local, pattern)) &&
				!patterns.some((pattern) => pattern.startsWith('!') && matchesGlob(local, pattern.slice(1)))
			) {
				const file = join(path, 'package.json')
				if (existsSync(file))
					packages.push({ directory: path, manifest: JSON.parse(readFileSync(file, 'utf8')) })
			}
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				if (
					entry.isDirectory() &&
					!['node_modules', 'dist', 'build', '.git', '.next', '_generated'].includes(entry.name)
				)
					walk(join(path, entry.name))
			}
		}
		walk(directory)
	}
	// The CLI may run inside one package of the workspace.
	for (let directory = root; ; directory = dirname(directory)) {
		visitRoot(directory)
		if (dirname(directory) === directory) break
	}
	return packages
}

function packageEntries(manifest, subpath) {
	const entries = []
	const add = (value, wildcard = '') => {
		if (Array.isArray(value)) {
			for (const item of value) add(item, wildcard)
		} else if (value && Object(value) === value) {
			for (const condition of ['source', 'types', 'import', 'default', 'require'])
				add(value[condition], wildcard)
		} else if (value) entries.push(value.replaceAll('*', wildcard))
	}
	const exports = manifest.exports
	const key = subpath ? `.${subpath}` : '.'
	if (exports && Object.hasOwn(exports, key)) add(exports[key])
	else if (
		!subpath &&
		(Object(exports) !== exports ||
			!Object.keys(exports ?? {}).some((name) => name.startsWith('.')))
	)
		add(exports)
	else if (exports) {
		for (const [pattern, value] of Object.entries(exports)) {
			const [prefix, suffix] = pattern.split('*')
			if (suffix !== undefined && key.startsWith(prefix) && key.endsWith(suffix))
				add(value, key.slice(prefix.length, suffix ? -suffix.length : undefined))
		}
	}
	if (!subpath)
		entries.push(...[manifest.source, manifest.main, 'src/index', 'src'].filter(Boolean))
	else if (!exports) entries.push(`.${subpath}`)
	return entries
}
