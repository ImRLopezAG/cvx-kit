// @vitest-environment node
import assert from 'node:assert/strict'
import { test, vi } from 'vite-plus/test'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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

async function assertGroupAbsent(pid) {
	const deadline = performance.now() + 1500
	while (performance.now() < deadline) {
		try {
			if (!processGroupAlive(pid)) return
		} catch (error) {
			if (error.code !== 'EPERM') throw error
		}
		await delay(20)
	}
	assert.fail('real process group did not reach ESRCH')
}

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

test('cleanup rechecks transient signal-0 EPERM after killing a real owned group', async () => {
	const kill = process.kill.bind(process)
	let pid,
		killed = false,
		denied = false,
		absent = false
	const probes = []
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target !== -pid) return kill(target, signal)
		if (signal === 'SIGKILL') {
			const result = kill(target, signal)
			killed = true
			return result
		}
		if (signal === 0 && killed && !denied) {
			denied = true
			probes.push('injected EPERM after real SIGKILL')
			throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
		}
		try {
			return kill(target, signal)
		} catch (error) {
			if (signal === 0) {
				probes.push(error.code)
				if (error.code === 'ESRCH') absent = true
			}
			throw error
		}
	})
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
		writeFileSync(join(proof, 'transient-eperm.json'), JSON.stringify({ result, probes }, null, 2))
		assert.match(result.stdout, /descendant:\d+/)
		assert.equal(denied, true, 'the race seam must be exercised')
		assert.equal(result.timeoutCleanup.error, undefined)
		assert.equal(result.timeoutCleanup.alive, false)
		assert.deepEqual(result.timeoutCleanup.errors, [])
		assert.equal(absent, true, 'success requires a real kernel ESRCH')
		assert.equal(result.cleanup.alive, false)
	} finally {
		spy.mockRestore()
		if (pid) {
			if (!killed) await cleanupOwnedProcess(pid, 150)
			await assertGroupAbsent(pid)
		}
	}
})

test('persistent signal-0 EPERM remains a bounded failure for a live owned group', async () => {
	const kill = process.kill.bind(process)
	let pid,
		denied = 0,
		deliveries = 0
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target === -pid) {
			if (signal === 0) {
				denied++
				throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
			}
			deliveries++
		}
		return kill(target, signal)
	})
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'setInterval(()=>{},1000)'],
			timeoutMs: 100,
			graceMs: 60,
			onSpawn: (value) => {
				pid = value
			},
		})
		assert.equal(result.timeoutCleanup.alive, true)
		assert.equal(result.timeoutCleanup.error.code, 'EPERM')
		assert.equal(result.cleanup.alive, true)
		assert.equal(result.cleanup.error.code, 'EPERM')
		assert.throws(() => processGroupAlive(pid), { code: 'EPERM' }, 'public probe stays strict')
		assert.equal(kill(-pid, 0), true, 'the denied group really remains alive')
		assert.equal(deliveries, 0, 'do not signal while the probe is permission-denied')
		assert.ok(result.milliseconds < 1000, 'permission retries must be bounded')
		const evidence = await collectOwnedCleanup({
			pids: [pid],
			ports: [],
			checkPort: () => {},
			graceMs: 60,
			failure: new Error('original proof failure'),
		})
		writeFileSync(
			join(proof, 'persistent-eperm.json'),
			JSON.stringify({ result, evidence, denied }, null, 2),
		)
		assert.equal(evidence.groups[0].alive, true)
		assert.equal(evidence.groups[0].error.code, 'EPERM')
		assert.equal(evidence.failure.message, 'original proof failure')
	} finally {
		spy.mockRestore()
		if (pid) {
			assert.equal((await cleanupOwnedProcess(pid, 150)).alive, false)
			assert.equal(processGroupAlive(pid), false)
		}
	}
})

test.each([1, 2])(
	'cleanup rechecks EPERM at probe %i after a real leader exits',
	async (atProbe) => {
		const kill = process.kill.bind(process)
		let pid,
			probes = 0,
			absent = false
		const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
			if (target === -pid && signal === 0 && ++probes === atProbe) {
				throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
			}
			try {
				return kill(target, signal)
			} catch (error) {
				if (target === -pid && signal === 0 && error.code === 'ESRCH') absent = true
				throw error
			}
		})
		try {
			const result = await runOwnedProcess({
				command: process.execPath,
				args: ['-e', 'process.exit(7)'],
				graceMs: 60,
				onSpawn: (value) => {
					pid = value
				},
			})
			assert.equal(result.code, 7, 'preserve the original nonzero exit')
			assert.equal(result.timedOut, false)
			assert.equal(result.cleanup.error, undefined)
			assert.equal(result.cleanup.alive, false)
			assert.deepEqual(result.cleanup.signals, [])
			assert.ok(probes > atProbe)
			assert.equal(absent, true)
		} finally {
			spy.mockRestore()
			if (pid) await assertGroupAbsent(pid)
		}
	},
)

test('EPERM followed by a live group remains a permission failure', async () => {
	const kill = process.kill.bind(process)
	let pid,
		denied = false,
		confirmedLive = false
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target === -pid && signal === 0) {
			if (!denied) {
				denied = true
				throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
			}
			const result = kill(target, signal)
			confirmedLive = true
			return result
		}
		return kill(target, signal)
	})
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'setInterval(()=>{},1000)'],
			timeoutMs: 100,
			graceMs: 60,
			onSpawn: (value) => {
				pid = value
			},
		})
		assert.equal(confirmedLive, true)
		assert.equal(result.timeoutCleanup.alive, true)
		assert.equal(result.timeoutCleanup.error.code, 'EPERM')
	} finally {
		spy.mockRestore()
		if (pid) {
			await cleanupOwnedProcess(pid, 150)
			await assertGroupAbsent(pid)
		}
	}
})

test('signal-0 errors other than EPERM are not retried or suppressed', async () => {
	const kill = process.kill.bind(process)
	let pid,
		probes = 0
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target === -pid && signal === 0) {
			probes++
			throw Object.assign(new Error('kill EINVAL'), { code: 'EINVAL' })
		}
		return kill(target, signal)
	})
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'process.exit(0)'],
			onSpawn: (value) => {
				pid = value
			},
		})
		assert.equal(result.cleanup.alive, true)
		assert.equal(result.cleanup.error.code, 'EINVAL')
		assert.equal(probes, 1)
	} finally {
		spy.mockRestore()
		if (pid) await assertGroupAbsent(pid)
	}
})

test('signal-delivery EPERM stays recorded and the real group is left alive', async () => {
	const kill = process.kill.bind(process)
	let pid
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target === -pid && signal !== 0) {
			throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
		}
		return kill(target, signal)
	})
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'setInterval(()=>{},1000)'],
			timeoutMs: 100,
			graceMs: 30,
			onSpawn: (value) => {
				pid = value
			},
		})
		for (const cleanup of [result.timeoutCleanup, result.cleanup]) {
			assert.equal(cleanup.alive, true)
			assert.deepEqual(cleanup.signals, [])
			assert.deepEqual(
				cleanup.errors,
				['SIGINT', 'SIGTERM', 'SIGKILL'].map((signal) => ({ signal, code: 'EPERM' })),
			)
		}
		assert.equal(kill(-pid, 0), true)
	} finally {
		spy.mockRestore()
		if (pid) {
			assert.equal((await cleanupOwnedProcess(pid, 150)).alive, false)
			await assertGroupAbsent(pid)
		}
	}
})

test('delivery EPERM caused by concurrent exit requires real ESRCH before cleanup succeeds', async () => {
	const kill = process.kill.bind(process)
	let pid,
		raced = false,
		absent = false
	const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
		if (target === -pid && signal === 'SIGINT' && !raced) {
			kill(target, 'SIGKILL')
			raced = true
			throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
		}
		try {
			return kill(target, signal)
		} catch (error) {
			if (target === -pid && signal === 0 && error.code === 'ESRCH') absent = true
			throw error
		}
	})
	try {
		const result = await runOwnedProcess({
			command: process.execPath,
			args: ['-e', 'setInterval(()=>{},1000)'],
			timeoutMs: 100,
			graceMs: 150,
			onSpawn: (value) => {
				pid = value
			},
		})
		writeFileSync(
			join(proof, 'delivery-race.json'),
			JSON.stringify({ result, raced, absent }, null, 2),
		)
		assert.equal(raced, true)
		assert.equal(result.timeoutCleanup.alive, false)
		assert.deepEqual(result.timeoutCleanup.errors, [])
		assert.deepEqual(result.timeoutCleanup.signals, [])
		assert.equal(absent, true)
	} finally {
		spy.mockRestore()
		if (pid) {
			if (!raced) await cleanupOwnedProcess(pid, 150)
			await assertGroupAbsent(pid)
		}
	}
})

test.each(['EPERM', 'EINVAL'])(
	'delivery %s while the group is live survives later successful cleanup',
	async (code) => {
		const kill = process.kill.bind(process)
		let pid,
			denied = false
		const spy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
			if (target === -pid && signal === 'SIGINT') {
				assert.equal(kill(target, 0), true)
				denied = true
				throw Object.assign(new Error('kill ' + code), { code })
			}
			return kill(target, signal)
		})
		try {
			const result = await runOwnedProcess({
				command: process.execPath,
				args: ['-e', 'setInterval(()=>{},1000)'],
				timeoutMs: 100,
				graceMs: 60,
				onSpawn: (value) => {
					pid = value
				},
			})
			assert.equal(denied, true)
			assert.equal(result.timeoutCleanup.alive, false)
			assert.deepEqual(result.timeoutCleanup.errors, [{ signal: 'SIGINT', code }])
			assert.deepEqual(result.timeoutCleanup.signals, ['SIGTERM'])
		} finally {
			spy.mockRestore()
			if (pid) {
				await cleanupOwnedProcess(pid, 150)
				await assertGroupAbsent(pid)
			}
		}
	},
)
