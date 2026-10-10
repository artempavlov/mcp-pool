import type { Socket } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP transport over a unix-domain socket. The wire format is identical to the
 * SDK's stdio transport (newline-delimited JSON), so each connection the daemon
 * accepts is a complete MCP session it can hand to its own Server.
 */
export class SocketTransport implements Transport {
	private readonly socket: Socket;
	private buffer = "";
	private started = false;
	private closed = false;

	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	sessionId?: string;

	constructor(socket: Socket) {
		this.socket = socket;
	}

	async start(): Promise<void> {
		if (this.started) {
			throw new Error("SocketTransport already started");
		}
		this.started = true;

		this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
		this.socket.on("error", (err: Error) => this.onerror?.(err));
		this.socket.on("close", () => {
			this.closed = true;
			this.onclose?.();
		});
	}

	async send(message: JSONRPCMessage): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.socket.write(`${JSON.stringify(message)}\n`, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.socket.destroy();
		this.closed = true;
		this.onclose?.();
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");

		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);

			if (line.trim().length > 0) {
				try {
					this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
				} catch (err) {
					this.onerror?.(err instanceof Error ? err : new Error(String(err)));
				}
			}

			index = this.buffer.indexOf("\n");
		}
	}
}
