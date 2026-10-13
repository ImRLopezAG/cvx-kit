import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const skill = resolve(import.meta.dirname, '../skills/cvx-kit')
const files = [
	join(skill, 'SKILL.md'),
	...readdirSync(join(skill, 'references')).map((name) => join(skill, 'references', name)),
]
for (const file of files) {
	if (!file.endsWith('.md')) continue
	const text = readFileSync(file, 'utf8')
	for (const [, link] of text.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)\)/g)) {
		if (link.includes(':') || link.startsWith('#')) continue
		const target = resolve(dirname(file), link.split('#')[0])
		if (!existsSync(target))
			throw new Error(`Missing skill reference: ${relative(skill, file)} -> ${link}`)
		const local = relative(realpathSync(skill), realpathSync(target))
		if (local === '..' || local.startsWith('../'))
			throw new Error(`Skill reference leaves the bundle: ${relative(skill, file)} -> ${link}`)
	}
}
console.log(`Checked ${files.length} cvx-kit skill documents`)
