import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export function processGroupAlive(pid) {
	try {
		process.kill(-pid, 0)
		return true
	} catch (error) {
		if (error.code === 'ESRCH') return false
		throw error
	}
}
const owned = new Set()
async function recheckGroupExit(pid, error, graceMs) {
	// macOS can find an exiting group with no signalable members and return
	// EPERM before reaping it. Only a subsequent ESRCH proves it is gone.
	// Never send another signal while permission to probe is uncertain.
	const deadline = performance.now() + graceMs
	while (performance.now() < deadline) {
		await delay(Math.min(20, deadline - performance.now()))
		try {
			if (!processGroupAlive(pid)) return false
		} catch (recheckError) {
			if (recheckError.code === 'EPERM') continue
			throw recheckError
		}
		// A live group does not resolve the original permission failure.
		throw error
	}
	throw error
}
async function ownedGroupAlive(pid, graceMs) {
	try {
		return processGroupAlive(pid)
	} catch (error) {
		if (error.code !== 'EPERM') throw error
		return recheckGroupExit(pid, error, graceMs)
	}
}
export async function cleanupOwnedProcess(pid, graceMs = 1000) {
	if (!owned.has(pid)) throw new Error('Process group is not owned by this runner')
	const signals = [],
		errors = []
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
		if (!(await ownedGroupAlive(pid, graceMs))) break
		try {
			process.kill(-pid, signal)
			signals.push(signal)
		} catch (error) {
			if (error.code === 'EPERM') {
				try {
					await recheckGroupExit(pid, error, graceMs)
					break // Confirmed ESRCH, just like ESRCH from the signal itself.
				} catch (recheckError) {
					if (recheckError.code !== 'EPERM') throw recheckError
				}
			}
			if (error.code !== 'ESRCH') errors.push({ signal, code: error.code })
		}
		const deadline = performance.now() + graceMs
		while ((await ownedGroupAlive(pid, graceMs)) && performance.now() < deadline) await delay(20)
	}
	return { pid, groupId: pid, signals, errors, alive: await ownedGroupAlive(pid, graceMs) }
}

export async function runOwnedProcess({
	command,
	args,
	cwd,
	env,
	timeoutMs = 180000,
	graceMs = 1000,
	onSpawn = () => {},
}) {
	const started = performance.now()
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
	let stdout = '',
		stderr = '',
		timedOut = false,
		spawnError,
		timeoutCleanup
	child.stdout.on('data', (bytes) => {
		stdout += bytes
	})
	child.stderr.on('data', (bytes) => {
		stderr += bytes
	})
	const closed = new Promise((resolve) => {
		child.once('error', (error) => {
			spawnError = { code: error.code, message: error.message }
			resolve({ code: null, signal: null })
		})
		child.once('close', (code, signal) => resolve({ code, signal }))
	})
	if (child.pid) {
		owned.add(child.pid)
		onSpawn(child.pid)
	}
	child.stdin.end()
	let finishTimeout
	const timeoutFinished = new Promise((resolve) => {
		finishTimeout = resolve
	})
	const timer = setTimeout(() => {
		timedOut = true
		timeoutCleanup = child.pid
			? cleanupOwnedProcess(child.pid, graceMs).catch((error) => ({
					pid: child.pid,
					alive: true,
					error: { code: error.code, message: error.message },
				}))
			: Promise.resolve(null)
		timeoutCleanup.then(() => finishTimeout({ code: child.exitCode, signal: child.signalCode }))
	}, timeoutMs)
	let exit, cleanup
	try {
		exit = await Promise.race([closed, timeoutFinished])
		if (timeoutCleanup) await timeoutCleanup
	} finally {
		clearTimeout(timer)
		if (child.pid) {
			try {
				cleanup = await cleanupOwnedProcess(child.pid, graceMs)
			} catch (error) {
				cleanup = {
					pid: child.pid,
					alive: true,
					error: { code: error.code, message: error.message },
				}
			}
		}
	}
	if (timedOut) {
		child.stdout.destroy()
		child.stderr.destroy()
		child.unref()
	}
	return {
		...exit,
		spawnError,
		stdout,
		stderr,
		timedOut,
		pid: child.pid,
		milliseconds: performance.now() - started,
		timeoutCleanup: await timeoutCleanup,
		cleanup,
	}
}

export async function collectOwnedCleanup({ pids, ports, checkPort, failure, graceMs = 1000 }) {
	const groups = []
	for (const pid of pids) {
		try {
			groups.push(await cleanupOwnedProcess(pid, graceMs))
		} catch (error) {
			groups.push({ pid, alive: true, error: { code: error.code, message: error.message } })
		}
	}
	const portResults = []
	for (const port of ports) {
		try {
			portResults.push({ port, closed: (await checkPort(port)) === port })
		} catch (error) {
			portResults.push({ port, closed: false, error: { code: error.code, message: error.message } })
		}
	}
	return {
		pids: groups.map(({ pid, alive }) => ({ pid, alive })),
		failure: failure ? { name: failure.name, message: failure.message } : null,
		groups,
		ports: portResults,
	}
}
