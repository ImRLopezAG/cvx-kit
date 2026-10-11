// @vitest-environment node
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	runOwnedProcess,
	cleanupOwnedProcess,
	processGroupAlive,
	collectOwnedCleanup,
} from './owned-process.mjs'

const proof = mkdtempSync('/tmp/cvx-owned-process-')
console.log('Owned cleanup evidence: ' + proof)

const descendant = `process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)`
const parent = `
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});
 process.on('SIGINT',()=>{}); process.on('SIGTERM',()=>{});
 child.stdout.once('data',()=>{console.log('descendant:'+child.pid); MODE});
 setInterval(()=>{},1000);
`

test('timeout terminates the entire owned group after ignored graceful signals', async () => {
	let pid
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', parent.replace('MODE', '')],
			timeoutMs: 1500,
			graceMs: 150,
			onSpawn: (value) => {
				pid = value
			},
		})
		writeFileSync(join(proof, 'timeout.json'), JSON.stringify(result, null, 2))
		assert.match(result.stdout, /descendant:\d+/)
		assert.equal(result.timedOut, true)
		assert.ok(result.timeoutCleanup.signals.includes('SIGKILL'))
		assert.equal(result.cleanup.alive, false)
		assert.equal(processGroupAlive(pid), false)
	} finally {
		if (pid) await cleanupOwnedProcess(pid, 150)
	}
})

test('failed leader preserves failure output and finally cleans its surviving descendant', async () => {
	let pid
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', parent.replace('MODE', "console.error('original failure'); process.exit(7)")],
			timeoutMs: 1500,
			graceMs: 150,
			onSpawn: (value) => {
				pid = value
			},
		})
		writeFileSync(join(proof, 'failed-leader.json'), JSON.stringify(result, null, 2))
		assert.equal(result.code, 7)
		assert.equal(result.timedOut, false)
		assert.match(result.stderr, /original failure/)
		assert.equal(result.cleanup.alive, false)
		assert.equal(processGroupAlive(pid), false)
	} finally {
		if (pid) await cleanupOwnedProcess(pid, 150)
	}
})

test('cleanup rejects a group that was not created by the runner', async () => {
	await assert.rejects(cleanupOwnedProcess(process.pid, 20), /not owned/)
})

test('port-check failure is recorded without replacing original proof failure', async () => {
	const server = createServer()
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'process.exit(7)'],
			timeoutMs: 1000,
		})
		const failure = new Error('original proof failure: exit ' + result.code)
		const evidence = await collectOwnedCleanup({
			pids: [result.pid],
			ports: [port],
			failure,
			checkPort: (requested) =>
				new Promise((resolve, reject) => {
					const probe = createServer()
					probe.once('error', reject)
					probe.listen(requested, '127.0.0.1', () => probe.close(() => resolve(requested)))
				}),
		})
		writeFileSync(join(proof, 'port-failure.json'), JSON.stringify(evidence, null, 2))
		assert.equal(evidence.failure.message, 'original proof failure: exit 7')
		assert.equal(evidence.ports[0].closed, false)
		assert.equal(evidence.ports[0].error.code, 'EADDRINUSE')
		assert.equal(evidence.groups[0].alive, false)
		assert.equal(server.listening, true, 'unrelated listener must never be killed')
	} finally {
		await new Promise((resolve) => server.close(resolve))
	}
})
