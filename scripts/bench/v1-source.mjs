// v1 (cvx-kit 0.1.35, Zod) is no longer in the tree. Benches that compare
// against it extract the last v1 revision with `git archive` into a temp dir
// and bundle the v1 fixture against that tree. `node_modules` in the temp dir
// is a symlink to this checkout's, so `zod`, `convex` and `convex-helpers`
// resolve to the versions installed here (the ones v1 was measured with).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The v1 revision to compare against: the last v1 commit (release 0.1.35) by default.
 * `CVX_BENCH_V1_REF` selects another v1 revision, e.g. the 0.2.0 release commit.
 */
export const V1_COMMIT = process.env.CVX_BENCH_V1_REF || '8d979a5'

const here = path.dirname(new URL(import.meta.url).pathname)
const checkout = path.resolve(here, '..', '..')

const git = (args) =>
	execFileSync('git', ['-C', checkout, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Why v1 cannot be extracted here, or `undefined` when it can: the checkout
 * is not a git repository, or it is a shallow clone without `V1_COMMIT`.
 */
export function v1Unavailable() {
	try {
		git(['cat-file', '-e', `${V1_COMMIT}^{commit}`])
		return undefined
	} catch {
		let shallow = false
		try {
			shallow = git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true'
		} catch {
			return `${checkout} is not a git checkout, so v1 (${V1_COMMIT}) cannot be extracted`
		}
		return shallow
			? `commit ${V1_COMMIT} is missing: this is a shallow clone (run \`git fetch --unshallow\`)`
			: `commit ${V1_COMMIT} is not in this repository`
	}
}

/**
 * Extracts `paths` of `V1_COMMIT` into a fresh temp dir and returns
 * `{ root, cleanup }`, or `{ reason }` when v1 is unavailable.
 */
export function extractV1(paths = ['src', 'scripts/bench']) {
	const reason = v1Unavailable()
	if (reason) return { reason }
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvx-v1-source-'))
	const archive = path.join(root, 'v1.tar')
	git(['archive', '--format=tar', '-o', archive, V1_COMMIT, ...paths])
	execFileSync('tar', ['-x', '-f', archive, '-C', root])
	fs.rmSync(archive)
	fs.symlinkSync(path.join(checkout, 'node_modules'), path.join(root, 'node_modules'), 'dir')
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Installed versions of the packages the v1/v2 comparison depends on. */
export function installedVersions(names = ['zod', 'convex', 'convex-helpers']) {
	return Object.fromEntries(
		names.map((name) => {
			try {
				const manifest = path.join(checkout, 'node_modules', name, 'package.json')
				return [name, JSON.parse(fs.readFileSync(manifest, 'utf8')).version]
			} catch {
				return [name, 'not installed']
			}
		}),
	)
}

/** One line naming the installed versions, for bench output. */
export function versionLine() {
	return Object.entries(installedVersions())
		.map(([name, version]) => `${name} ${version}`)
		.join(', ')
}
