import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runtimePaths } from "../src/ipc.js";

const _IDLE_GRACE_MS = 3_000;
const SHUTDOWN_WAIT_MS = 8_000;

interface Harness {
	configFile: string;
	socket: string;
	cleanup: () => Promise<void>;
}

function makeConfig(): Harness {
	const directory = mkdtempSync(join(tmpdir(), "mcp-pool-daemon-"));
	const configFile = join(directory, "config.yaml");
	// A pool whose upstream lives for the whole test; a second pool that the
	// daemon also owns so sharing is visible across two pools.
	const upstreamCount = join(directory, "upstream-count");
	writeFileSync(upstreamCount, "0", "utf8");

	writeFileSync(
		configFile,
		`pools:
  shared:
    command: bun
    args: ["run", "test/helper-server.ts"]
    keys:
      - { TEST_LIFECYCLE_FILE: "${join(directory, "lifecycle")}" }
    rateLimitPatterns: ["rate_limit_exceeded"]
`,
	);

	const socket = runtimePaths(configFile).socket;

	return {
		configFile,
		socket,
		cleanup: async () => {
			rmSync(upstreamCount, { force: true });
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function connect(
	configFile: string,
	name: string,
): { client: Client; transport: StdioClientTransport } {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["run", "src/index.ts", "--config", configFile],
	});
	return {
		transport,
		client: new Client({ name, version: "0.1.0" }, { capabilities: {} }),
	};
}

async function waitForGone(
	socket: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(socket)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return !existsSync(socket);
}

test(
	"daemon serves many agents over one upstream and exits when the last leaves",
	async () => {
		const harness = makeConfig();

		const first = connect(harness.configFile, "first-agent");
		const second = connect(harness.configFile, "second-agent");

		try {
			await first.client.connect(first.transport);
			await second.client.connect(second.transport);

			expect(existsSync(harness.socket)).toBe(true);

			// Both agents see the same pooled tools through the one daemon.
			const firstTools = await first.client.listTools();
			const secondTools = await second.client.listTools();
			expect(firstTools.tools[0]?.name).toBe("shared__echo");
			expect(firstTools.tools).toEqual(secondTools.tools);

			const firstResult = await first.client.callTool({
				name: "shared__echo",
				arguments: { message: "from-first" },
			});
			expect(firstResult.isError).toBeFalsy();

			const secondResult = await second.client.callTool({
				name: "shared__echo",
				arguments: { message: "from-second" },
			});
			expect(secondResult.isError).toBeFalsy();

			// One agent leaving must not tear the daemon down.
			await first.client.close().catch(() => {});
			await first.transport.close().catch(() => {});
			await new Promise((r) => setTimeout(r, 500));
			expect(existsSync(harness.socket)).toBe(true);

			// The surviving agent still works.
			const surviving = await second.client.callTool({
				name: "shared__echo",
				arguments: { message: "still-alive" },
			});
			expect(surviving.isError).toBeFalsy();

			// The last agent leaving shuts the daemon down.
			await second.client.close().catch(() => {});
			await second.transport.close().catch(() => {});

			const gone = await waitForGone(harness.socket, SHUTDOWN_WAIT_MS);
			expect(gone).toBe(true);
		} finally {
			await first.client.close().catch(() => {});
			await second.client.close().catch(() => {});
			await first.transport.close().catch(() => {});
			await second.transport.close().catch(() => {});
			await harness.cleanup();
		}
	},
	SHUTDOWN_WAIT_MS + 10_000,
);

test("recovers when a crashed daemon leaves a stale socket", async () => {
	const harness = makeConfig();

	const first = connect(harness.configFile, "crash-agent");
	const second = connect(harness.configFile, "recovery-agent");

	// Finds the daemon that owns our socket. The socket path is unique per
	// config, so matching on it cannot hit an unrelated daemon.
	const findDaemon = () => {
		const result = spawnSync("pgrep", ["-f", harness.socket]);
		const pids =
			result.status === 0 ? result.stdout.toString().trim().split("\n") : [];
		return pids.filter((pid) => /^\d+$/.test(pid));
	};

	try {
		await first.client.connect(first.transport);
		expect(existsSync(harness.socket)).toBe(true);

		const pids = findDaemon();
		expect(pids.length).toBeGreaterThan(0);

		// SIGKILL, so the daemon cannot clean up after itself.
		for (const pid of pids) {
			spawnSync("kill", ["-9", pid]);
		}
		expect(await waitForProcessesGone(findDaemon, 3_000)).toBe(true);

		// The socket file is left behind. A fresh agent must recover.
		expect(existsSync(harness.socket)).toBe(true);

		await second.client.connect(second.transport);
		const tools = await second.client.listTools();
		expect(tools.tools[0]?.name).toBe("shared__echo");

		const result = await second.client.callTool({
			name: "shared__echo",
			arguments: { message: "after-recovery" },
		});
		expect(result.isError).toBeFalsy();
	} finally {
		await first.client.close().catch(() => {});
		await second.client.close().catch(() => {});
		await first.transport.close().catch(() => {});
		await second.transport.close().catch(() => {});
		await harness.cleanup();
	}
}, 20_000);

async function waitForProcessesGone(
	find: () => string[],
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (find().length === 0) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return find().length === 0;
}
