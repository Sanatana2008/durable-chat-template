import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

const DEFAULT_SYMBOLS = ["AAPL", "NVDA", "MSFT"];
const MAX_SYMBOLS = 40;
const STORAGE_KEY = "watchlist_symbols";

type FinnhubTrade = {
	s: string;
	p: number;
	v: number;
	t: number;
	c?: string[];
};

type FinnhubMessage = {
	type: string;
	data?: FinnhubTrade[];
	msg?: string;
};

type ClientMessage =
	| {
			type: "set_symbols";
			symbols: string[];
	  }
	| {
			type: "get_symbols";
	  };

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	private finnhubSocket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	private symbols = new Set<string>(DEFAULT_SYMBOLS);
	private initialized = false;

	async onStart() {
		await this.loadWatchlist();
		this.connectFinnhub();
	}

	private async loadWatchlist() {
		if (this.initialized) {
			return;
		}

		this.initialized = true;

		try {
			const saved =
				await this.ctx.storage.get<string[]>(
					STORAGE_KEY,
				);

			if (
				Array.isArray(saved) &&
				saved.length > 0
			) {
				const normalized =
					this.normalizeSymbols(saved);

				if (normalized.length > 0) {
					this.symbols = new Set(
						normalized,
					);

					console.log(
						`Watchlist restored from storage (${this.symbols.size}/${MAX_SYMBOLS}): ${Array.from(
							this.symbols,
						).join(", ")}`,
					);

					return;
				}
			}

			await this.saveWatchlist();

			console.log(
				`Default watchlist stored: ${Array.from(
					this.symbols,
				).join(", ")}`,
			);
		} catch (error) {
			console.error(
				"Watchlist load error:",
				error,
			);
		}
	}

	private async saveWatchlist() {
		try {
			await this.ctx.storage.put(
				STORAGE_KEY,
				Array.from(this.symbols),
			);
		} catch (error) {
			console.error(
				"Watchlist save error:",
				error,
			);
		}
	}

	private normalizeSymbols(input: string[]) {
		const result: string[] = [];

		for (const raw of input) {
			const symbol = String(raw)
				.trim()
				.toUpperCase();

			if (!symbol) {
				continue;
			}

			if (
				!/^[A-Z0-9.\-:]{1,20}$/.test(
					symbol,
				)
			) {
				continue;
			}

			if (!result.includes(symbol)) {
				result.push(symbol);
			}

			if (
				result.length >= MAX_SYMBOLS
			) {
				break;
			}
		}

		return result;
	}

	private sendFinnhubCommand(
		type: "subscribe" | "unsubscribe",
		symbol: string,
	) {
		const ws = this.finnhubSocket;

		if (
			!ws ||
			ws.readyState !== WebSocket.OPEN
		) {
			return;
		}

		ws.send(
			JSON.stringify({
				type,
				symbol,
			}),
		);

		console.log(
			`Finnhub ${type}: ${symbol}`,
		);
	}

	private subscribeAll() {
		for (const symbol of this.symbols) {
			this.sendFinnhubCommand(
				"subscribe",
				symbol,
			);
		}
	}

	private broadcastSymbols() {
		this.broadcast(
			JSON.stringify({
				type: "symbols",
				symbols: Array.from(
					this.symbols,
				),
				maxSymbols: MAX_SYMBOLS,
			}),
		);
	}

	private async setSymbols(
		nextSymbols: string[],
	) {
		const normalized =
			this.normalizeSymbols(nextSymbols);

		if (normalized.length === 0) {
			console.log(
				"set_symbols ignored: empty symbol list",
			);
			return;
		}

		const oldSymbols =
			new Set(this.symbols);

		const newSymbols =
			new Set(normalized);

		for (const symbol of oldSymbols) {
			if (!newSymbols.has(symbol)) {
				this.sendFinnhubCommand(
					"unsubscribe",
					symbol,
				);
			}
		}

		for (const symbol of newSymbols) {
			if (!oldSymbols.has(symbol)) {
				this.sendFinnhubCommand(
					"subscribe",
					symbol,
				);
			}
		}

		this.symbols = newSymbols;

		await this.saveWatchlist();

		console.log(
			`Watchlist updated and stored (${this.symbols.size}/${MAX_SYMBOLS}): ${Array.from(
				this.symbols,
			).join(", ")}`,
		);

		this.broadcastSymbols();
	}

	private connectFinnhub() {
		if (
			this.finnhubSocket &&
			(this.finnhubSocket.readyState ===
				WebSocket.OPEN ||
				this.finnhubSocket.readyState ===
					WebSocket.CONNECTING)
		) {
			return;
		}

		const apiKey =
			this.env.FINNHUB_API_KEY;

		if (!apiKey) {
			console.error(
				"FINNHUB_API_KEY is missing",
			);

			this.broadcast(
				JSON.stringify({
					type: "status",
					status: "error",
					message:
						"FINNHUB_API_KEY is missing",
				}),
			);

			return;
		}

		console.log(
			"Connecting to Finnhub...",
		);

		const ws = new WebSocket(
			`wss://ws.finnhub.io?token=${encodeURIComponent(
				apiKey,
			)}`,
		);

		this.finnhubSocket = ws;

		ws.addEventListener("open", () => {
			console.log(
				"Finnhub WebSocket connected",
			);

			this.subscribeAll();

			this.broadcast(
				JSON.stringify({
					type: "status",
					status: "connected",
					symbols: Array.from(
						this.symbols,
					),
					maxSymbols: MAX_SYMBOLS,
				}),
			);

			this.broadcastSymbols();
		});

		ws.addEventListener(
			"message",
			(event) => {
				try {
					const message =
						JSON.parse(
							event.data as string,
						) as FinnhubMessage;

					if (
						message.type ===
							"trade" &&
						message.data
					) {
						for (const trade of message.data) {
							if (
								!this.symbols.has(
									trade.s,
								)
							) {
								continue;
							}

							const payload = {
								type: "trade",
								symbol:
									trade.s,
								price:
									trade.p,
								volume:
									trade.v,
								timestamp:
									trade.t,
								conditions:
									trade.c ??
									[],
							};

							console.log(
								`${payload.symbol}: ${payload.price} volume=${payload.volume}`,
							);

							this.broadcast(
								JSON.stringify(
									payload,
								),
							);
						}

						return;
					}

					if (
						message.type ===
						"error"
					) {
						console.error(
							"Finnhub message error:",
							message.msg ??
								message,
						);

						this.broadcast(
							JSON.stringify({
								type: "finnhub_error",
								message:
									message.msg ??
									"Unknown Finnhub error",
							}),
						);

						return;
					}

					console.log(
						"Finnhub system message:",
						message,
					);
				} catch (error) {
					console.error(
						"Finnhub message parse error:",
						error,
					);
				}
			},
		);

		ws.addEventListener(
			"close",
			(event) => {
				console.log(
					`Finnhub WebSocket closed: ${event.code} ${event.reason}`,
				);

				this.finnhubSocket = null;

				this.broadcast(
					JSON.stringify({
						type: "status",
						status:
							"disconnected",
						symbols:
							Array.from(
								this.symbols,
							),
						maxSymbols:
							MAX_SYMBOLS,
					}),
				);

				this.scheduleReconnect();
			},
		);

		ws.addEventListener(
			"error",
			(event) => {
				console.error(
					"Finnhub WebSocket error:",
					event,
				);
			},
		);
	}

	private scheduleReconnect() {
		if (this.reconnectTimer) {
			return;
		}

		console.log(
			"Finnhub reconnect scheduled in 5 seconds",
		);

		this.reconnectTimer =
			setTimeout(() => {
				this.reconnectTimer =
					null;

				this.connectFinnhub();
			}, 5000);
	}

	async onConnect(
		connection: Connection,
	) {
		await this.loadWatchlist();

		connection.send(
			JSON.stringify({
				type: "status",
				status:
					this.finnhubSocket
						?.readyState ===
					WebSocket.OPEN
						? "connected"
						: "connecting",
				symbols: Array.from(
					this.symbols,
				),
				maxSymbols: MAX_SYMBOLS,
			}),
		);

		connection.send(
			JSON.stringify({
				type: "symbols",
				symbols: Array.from(
					this.symbols,
				),
				maxSymbols: MAX_SYMBOLS,
			}),
		);

		this.connectFinnhub();
	}

	async onMessage(
		connection: Connection,
		rawMessage: WSMessage,
	) {
		try {
			if (
				typeof rawMessage !==
				"string"
			) {
				return;
			}

			const message =
				JSON.parse(
					rawMessage,
				) as ClientMessage;

			if (
				message.type ===
				"set_symbols"
			) {
				await this.setSymbols(
					message.symbols,
				);

				return;
			}

			if (
				message.type ===
				"get_symbols"
			) {
				await this.loadWatchlist();

				connection.send(
					JSON.stringify({
						type: "symbols",
						symbols:
							Array.from(
								this.symbols,
							),
						maxSymbols:
							MAX_SYMBOLS,
					}),
				);
			}
		} catch (error) {
			console.error(
				"Client message error:",
				error,
			);
		}
	}
}

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(
				request,
				{
					...env,
				},
			)) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
