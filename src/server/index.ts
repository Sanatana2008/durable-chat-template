import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

const DEFAULT_SYMBOLS = ["AAPL", "NVDA", "MSFT"];
const MAX_SYMBOLS = 40;

const WATCHLIST_STORAGE_KEY = "watchlist_symbols";
const PRICES_STORAGE_KEY = "latest_prices";
const ALERTS_STORAGE_KEY = "price_alerts";
const ALERT_STATES_STORAGE_KEY = "price_alert_states";

const PRICE_SAVE_INTERVAL_MS = 60_000;

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

type LatestTrade = {
	symbol: string;
	price: number;
	volume: number;
	timestamp: number;
};

type PriceAlert = {
	symbol: string;
	below: number | null;
	above: number | null;
	enabled: boolean;
};

type AlertZone =
	| "inside"
	| "below"
	| "above";

type AlertState = {
	symbol: string;
	zone: AlertZone;
};

type ClientMessage =
	| {
			type: "set_symbols";
			symbols: string[];
	  }
	| {
			type: "get_symbols";
	  }
	| {
			type: "get_snapshot";
	  }
	| {
			type: "get_alerts";
	  }
	| {
			type: "set_alert";
			symbol: string;
			below: number | null;
			above: number | null;
			enabled?: boolean;
	  }
	| {
			type: "delete_alert";
			symbol: string;
	  };

export class Chat extends Server<Env> {
	static options = {
		hibernate: true,
	};

	private finnhubSocket:
		| WebSocket
		| null = null;

	private reconnectTimer:
		| ReturnType<typeof setTimeout>
		| null = null;

	private priceSaveTimer:
		| ReturnType<typeof setTimeout>
		| null = null;

	private symbols =
		new Set<string>(
			DEFAULT_SYMBOLS,
		);

	private latestTrades =
		new Map<
			string,
			LatestTrade
		>();

	private alerts =
		new Map<
			string,
			PriceAlert
		>();

	private alertStates =
		new Map<
			string,
			AlertZone
		>();

	private initialized =
		false;

	private pricesDirty =
		false;


	// ==================================================
	// START
	// ==================================================

	async onStart() {
		await this.loadState();

		this.connectFinnhub();
	}


	// ==================================================
	// LOAD STATE
	// ==================================================

	private async loadState() {
		if (this.initialized) {
			return;
		}

		this.initialized =
			true;

		await this.loadWatchlist();

		await this.loadLatestPrices();

		await this.loadAlerts();

		await this.loadAlertStates();
	}


	// ==================================================
	// WATCHLIST STORAGE
	// ==================================================

	private async loadWatchlist() {
		try {
			const saved =
				await this.ctx.storage.get<
					string[]
				>(
					WATCHLIST_STORAGE_KEY,
				);

			if (
				Array.isArray(saved) &&
				saved.length > 0
			) {
				const normalized =
					this.normalizeSymbols(
						saved,
					);

				if (
					normalized.length >
					0
				) {
					this.symbols =
						new Set(
							normalized,
						);

					console.log(
						`Watchlist restored (${this.symbols.size}/${MAX_SYMBOLS}): ${Array.from(
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
				WATCHLIST_STORAGE_KEY,
				Array.from(
					this.symbols,
				),
			);

		} catch (error) {
			console.error(
				"Watchlist save error:",
				error,
			);
		}
	}


	// ==================================================
	// LATEST PRICES STORAGE
	// ==================================================

	private async loadLatestPrices() {
		try {
			const saved =
				await this.ctx.storage.get<
					Record<
						string,
						LatestTrade
					>
				>(
					PRICES_STORAGE_KEY,
				);

			if (!saved) {
				return;
			}

			for (
				const [
					symbol,
					trade,
				]
				of Object.entries(
					saved,
				)
			) {
				if (
					typeof trade?.price !==
						"number" ||
					typeof trade?.timestamp !==
						"number"
				) {
					continue;
				}

				this.latestTrades.set(
					symbol,
					trade,
				);
			}

			console.log(
				`Latest prices restored: ${this.latestTrades.size}`,
			);

		} catch (error) {
			console.error(
				"Latest prices load error:",
				error,
			);
		}
	}


	private schedulePriceSave() {
		this.pricesDirty =
			true;

		if (
			this.priceSaveTimer
		) {
			return;
		}

		this.priceSaveTimer =
			setTimeout(
				async () => {
					this.priceSaveTimer =
						null;

					await this.saveLatestPrices();
				},
				PRICE_SAVE_INTERVAL_MS,
			);
	}


	private async saveLatestPrices() {
		if (
			!this.pricesDirty
		) {
			return;
		}

		this.pricesDirty =
			false;

		try {
			const data: Record<
				string,
				LatestTrade
			> = {};

			for (
				const [
					symbol,
					trade,
				]
				of this.latestTrades
			) {
				data[symbol] =
					trade;
			}

			await this.ctx.storage.put(
				PRICES_STORAGE_KEY,
				data,
			);

			console.log(
				`Latest prices stored: ${Object.keys(
					data,
				).length}`,
			);

		} catch (error) {
			this.pricesDirty =
				true;

			console.error(
				"Latest prices save error:",
				error,
			);

			this.schedulePriceSave();
		}
	}


	// ==================================================
	// ALERT STORAGE
	// ==================================================

	private async loadAlerts() {
		try {
			const saved =
				await this.ctx.storage.get<
					Record<
						string,
						PriceAlert
					>
				>(
					ALERTS_STORAGE_KEY,
				);

			if (!saved) {
				return;
			}

			for (
				const [
					symbol,
					alert,
				]
				of Object.entries(
					saved,
				)
			) {
				if (
					!alert ||
					typeof alert !==
						"object"
				) {
					continue;
				}

				this.alerts.set(
					symbol,
					{
						symbol,
						below:
							typeof alert.below ===
							"number"
								? alert.below
								: null,

						above:
							typeof alert.above ===
							"number"
								? alert.above
								: null,

						enabled:
							alert.enabled !==
							false,
					},
				);
			}

			console.log(
				`Alerts restored: ${this.alerts.size}`,
			);

		} catch (error) {
			console.error(
				"Alerts load error:",
				error,
			);
		}
	}


	private async saveAlerts() {
		try {
			const data: Record<
				string,
				PriceAlert
			> = {};

			for (
				const [
					symbol,
					alert,
				]
				of this.alerts
			) {
				data[symbol] =
					alert;
			}

			await this.ctx.storage.put(
				ALERTS_STORAGE_KEY,
				data,
			);

		} catch (error) {
			console.error(
				"Alerts save error:",
				error,
			);
		}
	}


	// ==================================================
	// ALERT STATE STORAGE
	// ==================================================

	private async loadAlertStates() {
		try {
			const saved =
				await this.ctx.storage.get<
					Record<
						string,
						AlertZone
					>
				>(
					ALERT_STATES_STORAGE_KEY,
				);

			if (!saved) {
				return;
			}

			for (
				const [
					symbol,
					zone,
				]
				of Object.entries(
					saved,
				)
			) {
				if (
					zone === "inside" ||
					zone === "below" ||
					zone === "above"
				) {
					this.alertStates.set(
						symbol,
						zone,
					);
				}
			}

			console.log(
				`Alert states restored: ${this.alertStates.size}`,
			);

		} catch (error) {
			console.error(
				"Alert states load error:",
				error,
			);
		}
	}


	private async saveAlertStates() {
		try {
			const data: Record<
				string,
				AlertZone
			> = {};

			for (
				const [
					symbol,
					zone,
				]
				of this.alertStates
			) {
				data[symbol] =
					zone;
			}

			await this.ctx.storage.put(
				ALERT_STATES_STORAGE_KEY,
				data,
			);

		} catch (error) {
			console.error(
				"Alert states save error:",
				error,
			);
		}
	}


	// ==================================================
	// NORMALIZE SYMBOLS
	// ==================================================

	private normalizeSymbols(
		input: string[],
	) {
		const result:
			string[] = [];

		for (
			const raw
			of input
		) {
			const symbol =
				String(raw)
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

			if (
				!result.includes(
					symbol,
				)
			) {
				result.push(
					symbol,
				);
			}

			if (
				result.length >=
				MAX_SYMBOLS
			) {
				break;
			}
		}

		return result;
	}


	// ==================================================
	// FINNHUB COMMANDS
	// ==================================================

	private sendFinnhubCommand(
		type:
			| "subscribe"
			| "unsubscribe",
		symbol: string,
	) {
		const ws =
			this.finnhubSocket;

		if (
			!ws ||
			ws.readyState !==
				WebSocket.OPEN
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
		for (
			const symbol
			of this.symbols
		) {
			this.sendFinnhubCommand(
				"subscribe",
				symbol,
			);
		}
	}


	// ==================================================
	// SYMBOLS BROADCAST
	// ==================================================

	private broadcastSymbols() {
		this.broadcast(
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


	// ==================================================
	// SNAPSHOT
	// ==================================================

	private createSnapshot() {
		const trades:
			LatestTrade[] = [];

		for (
			const symbol
			of this.symbols
		) {
			const trade =
				this.latestTrades.get(
					symbol,
				);

			if (trade) {
				trades.push(
					trade,
				);
			}
		}

		return {
			type:
				"snapshot",

			trades,
		};
	}


	private sendSnapshot(
		connection: Connection,
	) {
		connection.send(
			JSON.stringify(
				this.createSnapshot(),
			),
		);
	}


	private broadcastSnapshot() {
		this.broadcast(
			JSON.stringify(
				this.createSnapshot(),
			),
		);
	}


	// ==================================================
	// ALERT BROADCAST
	// ==================================================

	private createAlertsPayload() {
		return {
			type:
				"alerts",

			alerts:
				Array.from(
					this.alerts.values(),
				),
		};
	}


	private sendAlerts(
		connection: Connection,
	) {
		connection.send(
			JSON.stringify(
				this.createAlertsPayload(),
			),
		);
	}


	private broadcastAlerts() {
		this.broadcast(
			JSON.stringify(
				this.createAlertsPayload(),
			),
		);
	}


	// ==================================================
	// SET WATCHLIST
	// ==================================================

	private async setSymbols(
		nextSymbols: string[],
	) {
		const normalized =
			this.normalizeSymbols(
				nextSymbols,
			);

		if (
			normalized.length ===
			0
		) {
			console.log(
				"set_symbols ignored: empty symbol list",
			);

			return;
		}

		const oldSymbols =
			new Set(
				this.symbols,
			);

		const newSymbols =
			new Set(
				normalized,
			);

		for (
			const symbol
			of oldSymbols
		) {
			if (
				!newSymbols.has(
					symbol,
				)
			) {
				this.sendFinnhubCommand(
					"unsubscribe",
					symbol,
				);
			}
		}

		for (
			const symbol
			of newSymbols
		) {
			if (
				!oldSymbols.has(
					symbol,
				)
			) {
				this.sendFinnhubCommand(
					"subscribe",
					symbol,
				);
			}
		}

		this.symbols =
			newSymbols;

		await this.saveWatchlist();

		console.log(
			`Watchlist updated and stored (${this.symbols.size}/${MAX_SYMBOLS}): ${Array.from(
				this.symbols,
			).join(", ")}`,
		);

		this.broadcastSymbols();

		this.broadcastSnapshot();
	}


	// ==================================================
	// SET ALERT
	// ==================================================

	private async setAlert(
		symbolRaw: string,
		belowRaw: number | null,
		aboveRaw: number | null,
		enabled = true,
	) {
		const symbol =
			symbolRaw
				.trim()
				.toUpperCase();

		if (
			!this.symbols.has(
				symbol,
			)
		) {
			console.log(
				`Alert ignored: ${symbol} is not in watchlist`,
			);

			return;
		}

		const below =
			typeof belowRaw ===
				"number" &&
			Number.isFinite(
				belowRaw,
			) &&
			belowRaw > 0
				? belowRaw
				: null;

		const above =
			typeof aboveRaw ===
				"number" &&
			Number.isFinite(
				aboveRaw,
			) &&
			aboveRaw > 0
				? aboveRaw
				: null;

		if (
			below !== null &&
			above !== null &&
			below >= above
		) {
			console.log(
				`Invalid alert range for ${symbol}: below=${below}, above=${above}`,
			);

			return;
		}

		if (
			below === null &&
			above === null
		) {
			this.alerts.delete(
				symbol,
			);

			this.alertStates.delete(
				symbol,
			);

			await this.saveAlerts();

			await this.saveAlertStates();

			this.broadcastAlerts();

			return;
		}

		const alert:
			PriceAlert = {
				symbol,
				below,
				above,
				enabled,
			};

		this.alerts.set(
			symbol,
			alert,
		);

		const latest =
			this.latestTrades.get(
				symbol,
			);

		if (latest) {
			const currentZone =
				this.getAlertZone(
					alert,
					latest.price,
				);

			this.alertStates.set(
				symbol,
				currentZone,
			);
		} else {
			this.alertStates.delete(
				symbol,
			);
		}

		await this.saveAlerts();

		await this.saveAlertStates();

		console.log(
			`Alert stored for ${symbol}: below=${below}, above=${above}, enabled=${enabled}`,
		);

		this.broadcastAlerts();
	}


	// ==================================================
	// DELETE ALERT
	// ==================================================

	private async deleteAlert(
		symbolRaw: string,
	) {
		const symbol =
			symbolRaw
				.trim()
				.toUpperCase();

		this.alerts.delete(
			symbol,
		);

		this.alertStates.delete(
			symbol,
		);

		await this.saveAlerts();

		await this.saveAlertStates();

		console.log(
			`Alert deleted: ${symbol}`,
		);

		this.broadcastAlerts();
	}


	// ==================================================
	// ALERT ENGINE
	// ==================================================

	private getAlertZone(
		alert: PriceAlert,
		price: number,
	): AlertZone {
		if (
			alert.below !==
				null &&
			price <=
				alert.below
		) {
			return "below";
		}

		if (
			alert.above !==
				null &&
			price >=
				alert.above
		) {
			return "above";
		}

		return "inside";
	}


	private async processPriceAlert(
		trade: LatestTrade,
	) {
		const alert =
			this.alerts.get(
				trade.symbol,
			);

		if (
			!alert ||
			!alert.enabled
		) {
			return;
		}

		const newZone =
			this.getAlertZone(
				alert,
				trade.price,
			);

		const previousZone =
			this.alertStates.get(
				trade.symbol,
			);


		// První známý stav pouze uložíme.
		// Nechceme okamžitě poslat alert
		// po restartu aplikace.

		if (!previousZone) {
			this.alertStates.set(
				trade.symbol,
				newZone,
			);

			await this.saveAlertStates();

			console.log(
				`${trade.symbol}: initial alert zone = ${newZone}`,
			);

			return;
		}


		// Stejná zóna = žádný nový alert.

		if (
			previousZone ===
			newZone
		) {
			return;
		}


		// Stav se změnil.

		this.alertStates.set(
			trade.symbol,
			newZone,
		);

		await this.saveAlertStates();


		// Návrat dovnitř pásma
		// pouze resetuje ochranu.

		if (
			newZone ===
			"inside"
		) {
			console.log(
				`${trade.symbol}: alert reset - price returned inside range`,
			);

			this.broadcast(
				JSON.stringify({
					type:
						"alert_reset",

					symbol:
						trade.symbol,

					price:
						trade.price,
				}),
			);

			return;
		}


		// ==================================================
		// NOVÝ ALERT
		// ==================================================

		const boundary =
			newZone ===
			"below"
				? alert.below
				: alert.above;

		const alertPayload = {
			type:
				"price_alert",

			symbol:
				trade.symbol,

			zone:
				newZone,

			price:
				trade.price,

			boundary,

			timestamp:
				trade.timestamp,
		};


		console.log(
			"PRICE ALERT TRIGGERED:",
			JSON.stringify(
				alertPayload,
			),
		);


		this.broadcast(
			JSON.stringify(
				alertPayload,
			),
		);


		// ==================================================
		// EMAIL BUDE DOPLNĚN V DALŠÍM KROKU
		// ==================================================
	}


	// ==================================================
	// FINNHUB CONNECTION
	// ==================================================

	private connectFinnhub() {
		if (
			this.finnhubSocket &&
			(
				this.finnhubSocket
					.readyState ===
					WebSocket.OPEN ||
				this.finnhubSocket
					.readyState ===
					WebSocket.CONNECTING
			)
		) {
			return;
		}

		const apiKey =
			this.env
				.FINNHUB_API_KEY;

		if (!apiKey) {
			console.error(
				"FINNHUB_API_KEY is missing",
			);

			this.broadcast(
				JSON.stringify({
					type:
						"status",

					status:
						"error",

					message:
						"FINNHUB_API_KEY is missing",
				}),
			);

			return;
		}

		console.log(
			"Connecting to Finnhub...",
		);

		const ws =
			new WebSocket(
				`wss://ws.finnhub.io?token=${encodeURIComponent(
					apiKey,
				)}`,
			);

		this.finnhubSocket =
			ws;


		ws.addEventListener(
			"open",
			() => {
				console.log(
					"Finnhub WebSocket connected",
				);

				this.subscribeAll();

				this.broadcast(
					JSON.stringify({
						type:
							"status",

						status:
							"connected",

						symbols:
							Array.from(
								this.symbols,
							),

						maxSymbols:
							MAX_SYMBOLS,
					}),
				);

				this.broadcastSymbols();

				this.broadcastSnapshot();

				this.broadcastAlerts();
			},
		);


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
						for (
							const trade
							of message.data
						) {
							if (
								!this.symbols.has(
									trade.s,
								)
							) {
								continue;
							}


							const latest:
								LatestTrade =
								{
									symbol:
										trade.s,

									price:
										trade.p,

									volume:
										trade.v,

									timestamp:
										trade.t,
								};


							this.latestTrades.set(
								trade.s,
								latest,
							);


							this.schedulePriceSave();


							const payload = {
								type:
									"trade",

								...latest,

								conditions:
									trade.c ??
									[],
							};


							this.broadcast(
								JSON.stringify(
									payload,
								),
							);


							void this.processPriceAlert(
								latest,
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
								type:
									"finnhub_error",

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

				this.finnhubSocket =
					null;

				this.broadcast(
					JSON.stringify({
						type:
							"status",

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


	// ==================================================
	// RECONNECT
	// ==================================================

	private scheduleReconnect() {
		if (
			this.reconnectTimer
		) {
			return;
		}

		console.log(
			"Finnhub reconnect scheduled in 5 seconds",
		);

		this.reconnectTimer =
			setTimeout(
				() => {
					this.reconnectTimer =
						null;

					this.connectFinnhub();
				},
				5000,
			);
	}


	// ==================================================
	// CLIENT CONNECT
	// ==================================================

	async onConnect(
		connection: Connection,
	) {
		await this.loadState();


		connection.send(
			JSON.stringify({
				type:
					"status",

				status:
					this.finnhubSocket
						?.readyState ===
					WebSocket.OPEN
						? "connected"
						: "connecting",

				symbols:
					Array.from(
						this.symbols,
					),

				maxSymbols:
					MAX_SYMBOLS,
			}),
		);


		connection.send(
			JSON.stringify({
				type:
					"symbols",

				symbols:
					Array.from(
						this.symbols,
					),

				maxSymbols:
					MAX_SYMBOLS,
			}),
		);


		this.sendSnapshot(
			connection,
		);


		this.sendAlerts(
			connection,
		);


		this.connectFinnhub();
	}


	// ==================================================
	// CLIENT MESSAGE
	// ==================================================

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
				await this.loadState();

				connection.send(
					JSON.stringify({
						type:
							"symbols",

						symbols:
							Array.from(
								this.symbols,
							),

						maxSymbols:
							MAX_SYMBOLS,
					}),
				);

				return;
			}


			if (
				message.type ===
				"get_snapshot"
			) {
				await this.loadState();

				this.sendSnapshot(
					connection,
				);

				return;
			}


			if (
				message.type ===
				"get_alerts"
			) {
				await this.loadState();

				this.sendAlerts(
					connection,
				);

				return;
			}


			if (
				message.type ===
				"set_alert"
			) {
				await this.setAlert(
					message.symbol,
					message.below,
					message.above,
					message.enabled ??
						true,
				);

				return;
			}


			if (
				message.type ===
				"delete_alert"
			) {
				await this.deleteAlert(
					message.symbol,
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


// ======================================================
// WORKER
// ======================================================

export default {
	async fetch(
		request,
		env,
	) {
		return (
			(
				await routePartykitRequest(
					request,
					{
						...env,
					},
				)
			) ||
			env.ASSETS.fetch(
				request,
			)
		);
	},
} satisfies ExportedHandler<Env>;
