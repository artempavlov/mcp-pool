import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../package.json" with { type: "json" };
import { log } from "./logger.js";
import { Pool } from "./pool.js";
import type { PoolConfig } from "./types.js";

/**
 * Starts every pool concurrently and fails as a group when any fails, closing
 * the ones that did start. Parallel start removes the head-of-line stall where a
 * single hanging upstream delayed every pool behind it.
 */
export async function startPools(
	config: Record<string, PoolConfig>,
): Promise<Pool[]> {
	const pools = Object.entries(config).map(
		([name, poolConfig]) => new Pool(name, poolConfig),
	);
	const settled = await Promise.allSettled(pools.map((pool) => pool.start()));

	const failure = settled.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failure) {
		await Promise.allSettled(pools.map((pool) => pool.close()));
		throw failure.reason;
	}

	return pools;
}

/**
 * Builds an MCP server bound to one set of pools. Callers create one of these
 * per connection so every client gets its own session over shared pools.
 */
export function buildServer(pools: Pool[], verbose: boolean): Server {
	const server = new Server(
		{ name: "mcp-pool", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		const tools: Array<{
			name: string;
			description?: string;
			inputSchema: {
				type: "object";
				properties?: Record<string, unknown>;
				required?: string[];
			};
		}> = [];

		for (const pool of pools) {
			const prefix = `${pool.name}__`;
			for (const tool of pool.getTools()) {
				tools.push({
					name: prefix + tool.name,
					description: tool.description
						? `[${pool.name}] ${tool.description}`
						: `[${pool.name}]`,
					inputSchema: tool.inputSchema,
				});
			}
		}

		return { tools };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const fullName = request.params.name;
		const separatorIndex = fullName.indexOf("__");
		if (separatorIndex === -1) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Invalid tool name: "${fullName}". Expected format: {poolName}__{toolName}`,
					},
				],
				isError: true,
			};
		}

		const poolName = fullName.slice(0, separatorIndex);
		const toolName = fullName.slice(separatorIndex + 2);
		const pool = pools.find((p) => p.name === poolName);

		if (!pool) {
			return {
				content: [
					{ type: "text" as const, text: `Unknown pool: "${poolName}"` },
				],
				isError: true,
			};
		}

		log({
			level: "info",
			event: "route",
			pool: poolName,
			tool: toolName,
			upstream: -1,
		});

		return (await pool.routeCall(
			toolName,
			request.params.arguments ?? {},
			verbose,
		)) as {
			content: Array<{ type: "text"; text: string; annotations?: unknown }>;
			isError?: boolean;
		};
	});

	return server;
}
