import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Window the last agent waits before a quiet daemon shuts itself down. */
export const IDLE_GRACE_MS = 3_000;
/** How long a freshly spawned proxy waits for the daemon's socket to appear. */
const DAEMON_START_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 25;

export interface RuntimePaths {
	dir: string;
	socket: string;
	status: string;
}

/**
 * Runtime paths are keyed by the resolved config path, so two different configs
 * get two different daemons instead of fighting over one socket. The directory
 * is under $HOME, not os.tmpdir(): the SDK's stdio transport filters TMPDIR out
 * of the child environment, which would otherwise give the daemon a different
 * directory than the agent process that spawned it.
 */
export function runtimePaths(configPath: string): RuntimePaths {
	const key = createHash("sha256")
		.update(resolve(configPath))
		.digest("hex")
		.slice(0, 16);
	const socket = join(homedir(), ".mcp-pool", `${key}.sock`);
	return { dir: dirname(socket), socket, status: `${socket}.status` };
}

/** Writes "ready" or the daemon's startup error so proxies fail fast. */
export function writeStatus(paths: RuntimePaths, message: string): void {
	try {
		writeFileSync(paths.status, message);
	} catch {
		// A missing status file only costs the proxy an extra retry.
	}
}

export function clearStatus(paths: RuntimePaths): void {
	rmSync(paths.status, { force: true });
}

/** Returns "ready" once the daemon is listening, or the error it died with. */
export function readStatus(paths: RuntimePaths): string | null {
	try {
		return readFileSync(paths.status, "utf8");
	} catch {
		return null;
	}
}

/**
 * Runtime paths for a socket that an explicit path already names. Keeps the
 * daemon on the exact socket the proxy chose, instead of re-deriving one.
 */
export function runtimePathsForSocket(socket: string): RuntimePaths {
	return { dir: dirname(socket), socket, status: `${socket}.status` };
}

/** True when the socket file is absent or has no live listener behind it. */
export function isStaleSocket(err: unknown): boolean {
	const code = (err as NodeJS.ErrnoException | null)?.code;
	return code === "ENOENT" || code === "ECONNREFUSED";
}

function socketAlive(socketPath: string): boolean {
	try {
		statSync(socketPath);
		return true;
	} catch {
		return false;
	}
}

export function connectOnce(socketPath: string): Promise<Socket> {
	return new Promise((resolvePromise, reject) => {
		const socket = connect(socketPath);
		const onError = (err: Error) => {
			socket.destroy();
			reject(err);
		};
		socket.once("error", onError);
		socket.once("connect", () => {
			socket.off("error", onError);
			// Errors after the handshake are reported to the caller by 'close'.
			socket.on("error", () => {});
			resolvePromise(socket);
		});
	});
}

/** Connects, spawning the daemon when the socket is missing or stale. */
export async function connectOrSpawn(
	paths: RuntimePaths,
	configPath: string,
	verbose: boolean,
): Promise<Socket> {
	// Two agents can race to spawn; the loser's daemon hits EADDRINUSE and exits,
	// so the loser only has to retry connecting.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await connectOnce(paths.socket);
		} catch (err) {
			if (!isStaleSocket(err)) throw err;
			// ENOENT: no daemon yet. ECONNREFUSED: socket left over from a crashed
			// daemon. Either way the file cannot be trusted.
			if (socketAlive(paths.socket)) {
				rmSync(paths.socket, { force: true });
			}
			spawnDaemon(paths, configPath, verbose);
		}
	}

	return await connectWithRetry(paths);
}

async function connectWithRetry(paths: RuntimePaths): Promise<Socket> {
	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
	let lastError: unknown;

	while (Date.now() < deadline) {
		// A daemon that failed to start reports why, instead of leaving the proxy
		// to spin for the whole timeout.
		const status = readStatus(paths);
		if (status !== null && status !== "ready") {
			throw new Error(`mcp-pool daemon failed to start: ${status}`);
		}

		try {
			return await connectOnce(paths.socket);
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
		}
	}

	throw new Error(`daemon did not start within ${DAEMON_START_TIMEOUT_MS}ms`, {
		cause: lastError,
	});
}

/**
 * Spawns a detached daemon so it outlives the agent that started it. That is
 * what lets a second agent reuse it instead of forking its own copies.
 */
export function spawnDaemon(
	paths: RuntimePaths,
	configPath: string,
	verbose: boolean,
): void {
	// Re-exec the entry that is already running: dev mode is src/index.ts,
	// installed mode is dist/index.js. argv[1] is correct for both.
	const entry = process.argv[1];
	if (!entry)
		throw new Error("cannot determine daemon entry from process.argv[1]");

	const argv = [
		entry,
		"--daemon",
		"--config",
		configPath,
		"--socket",
		paths.socket,
	];
	if (verbose) argv.push("--verbose");

	const child = spawn(process.execPath, argv, {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
