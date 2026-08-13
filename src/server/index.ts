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

const EMAIL = "k.bittner.k@gmail.com";


// ======================================================
// TYPES
// ======================================================

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


// ======================================================
// GMAIL HELPERS
// ======================================================

function bytesToBase64(
	bytes: Uint8Array,
) {
	let binary = "";

	const chunkSize =
		0x8000;

	for (
		let i = 0;
		i < bytes.length;
		i += chunkSize
	) {
		const chunk =
			bytes.subarray(
				i,
				Math.min(
					i + chunkSize,
					bytes.length,
				),
			);

		binary +=
			String.fromCharCode(
				...chunk,
			);
	}

	return btoa(binary);
}


function toBase64Url(
	text: string,
) {
	const bytes =
		new TextEncoder()
			.encode(text);

	return bytesToBase64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}


// ======================================================
// DURABLE OBJECT
// ======================================================

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

	// Ochrana proti několika současným
	// e-mailům pro stejný ticker.
	private alertProcessing =
		new Set<string>();

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
	// LATEST PRICES
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
	// GMAIL OAUTH
	// ==================================================

	private async getGmailAccessToken() {
		const clientId =
			this.env.GMAIL_CLIENT_ID;

		const clientSecret =
			this.env.GMAIL_CLIENT_SECRET;

		const refreshToken =
			this.env.GMAIL_REFRESH_TOKEN;


		if (
			!clientId ||
			!clientSecret ||
			!refreshToken
		) {
			throw new Error(
				"Missing Gmail OAuth secrets.",
			);
		}


		const response =
			await fetch(
				"https://oauth2.googleapis.com/token",
				{
					method:
						"POST",

					headers: {
						"content-type":
							"application/x-www-form-urlencoded",
					},

					body:
						new URLSearchParams({
							client_id:
								clientId,

							client_secret:
								clientSecret,

							refresh_token:
								refreshToken,

							grant_type:
								"refresh_token",
						}),
				},
			);


		const data =
			await response.json() as {
				access_token?: string;
				error?: string;
				error_description?: string;
			};


		if (!response.ok) {
			throw new Error(
				`Google OAuth HTTP ${response.status}: ${JSON.stringify(
					data,
				)}`,
			);
		}


		if (
			!data.access_token
		) {
			throw new Error(
				"Google OAuth nevrátil access token.",
			);
		}


		return data.access_token;
	}


	// ==================================================
	// GMAIL SEND
	// ==================================================

	private async sendEmail(
		subject: string,
		text: string,
	) {
		const accessToken =
			await this.getGmailAccessToken();


		const email =
			`From: Stocktrade Alerts <${EMAIL}>\r\n` +
			`To: ${EMAIL}\r\n` +
			`Subject: ${subject}\r\n` +
			`MIME-Version: 1.0\r\n` +
			`Content-Type: text/plain; charset=UTF-8\r\n` +
			`Content-Transfer-Encoding: 8bit\r\n` +
			`\r\n` +
			text;


		const raw =
			toBase64Url(email);


		const response =
			await fetch(
				"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
				{
					method:
						"POST",

					headers: {
						Authorization:
							`Bearer ${accessToken}`,

						"Content-Type":
							"application/json",
					},

					body:
						JSON.stringify({
							raw,
						}),
				},
			);


		const data =
			await response.json() as {
				id?: string;
				error?: unknown;
			};


		if (!response.ok) {
			throw new Error(
				`Gmail API HTTP ${response.status}: ${JSON.stringify(
					data,
				)}`,
			);
		}


		if (!data.id) {
			throw new Error(
				"Gmail API nevrátil Message ID.",
			);
		}


		return data.id;
	}


	// ==================================================
	// SYMBOL NORMALIZATION
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
	// SYMBOLS
	// ==================================================

	private broadcastSymbols() {
		this.broadcast(
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


		// DŮLEŽITÉ:
		// Při změně nastavení alertu nastavíme
		// současnou cenovou zónu jako výchozí.
		// Samotné uložení alertu tedy neposílá e-mail.

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
	// ALERT ZONE
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


	// ==================================================
	// ALERT EMAIL
	// ==================================================

	private async sendPriceAlertEmail(
		alert: PriceAlert,
		trade: LatestTrade,
		zone:
			| "below"
			| "above",
	) {
		const boundary =
			zone === "below"
				? alert.below
				: alert.above;


		const directionText =
			zone === "below"
				? "klesl pod nastavenou hranici"
				: "vzrostl nad nastavenou hranici";


		const subject =
			`Stocktrade Alert - ${trade.symbol}`;


		const text =
			"Stocktrade Alerts\n\n" +

			`${trade.symbol} ${directionText}.\n\n` +

			`Aktuální cena: ${trade.price} USD\n` +

			`Hranice: ${boundary} USD\n` +

			`Směr: ${zone.toUpperCase()}\n\n` +

			`Čas trhu: ${new Date(
				trade.timestamp,
			).toISOString()}\n` +

			`Odesláno: ${new Date().toISOString()}\n\n` +

			"Stocktrade Live";


		return await this.sendEmail(
			subject,
			text,
		);
	}


	// ==================================================
	// ALERT ENGINE
	// ==================================================

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


		// Pokud právě pro stejný ticker
		// probíhá Gmail request, další tick
		// ho nebude duplikovat.

		if (
			this.alertProcessing.has(
				trade.symbol,
			)
		) {
			return;
		}


		this.alertProcessing.add(
			trade.symbol,
		);


		try {
			const newZone =
				this.getAlertZone(
					alert,
					trade.price,
				);


			const previousZone =
				this.alertStates.get(
					trade.symbol,
				);


			// ----------------------------------------------
			// PRVNÍ STAV
			// ----------------------------------------------
			//
			// První známou zónu jen uložíme.
			// Po restartu nebo novém alertu
			// neposíláme okamžitě e-mail.

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


			// ----------------------------------------------
			// ZÓNA SE NEZMĚNILA
			// ----------------------------------------------

			if (
				previousZone ===
				newZone
			) {
				return;
			}


			// ----------------------------------------------
			// NÁVRAT DO PÁSMA
			// ----------------------------------------------

			if (
				newZone ===
				"inside"
			) {
				this.alertStates.set(
					trade.symbol,
					"inside",
				);

				await this.saveAlertStates();


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


			// ----------------------------------------------
			// NOVÉ PŘEKROČENÍ HRANICE
			// ----------------------------------------------

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


			// ==================================================
			// 1. NEJDŘÍVE GMAIL
			// ==================================================
			//
			// Pokud Gmail selže:
			// alertStates se NEZMĚNÍ.
			// Další tick se tedy může pokusit znovu.

			try {
				const gmailMessageId =
					await this.sendPriceAlertEmail(
						alert,
						trade,
						newZone,
					);


				console.log(
					"EMAIL ALERT SENT:",
					JSON.stringify(
						alertPayload,
					),
				);


				console.log(
					"Gmail Message ID:",
					gmailMessageId,
				);


				// ==================================================
				// 2. GMAIL USPĚL → TEPRVE TEĎ ULOŽÍME ZÓNU
				// ==================================================

				this.alertStates.set(
					trade.symbol,
					newZone,
				);


				await this.saveAlertStates();


				// A až potom oznámíme alert klientovi.

				this.broadcast(
					JSON.stringify(
						alertPayload,
					),
				);

			} catch (error) {
				console.error(
					"EMAIL ALERT ERROR:",
					error instanceof Error
						? error.message
						: String(error),
				);


				this.broadcast(
					JSON.stringify({
						type:
							"alert_email_error",

						symbol:
							trade.symbol,

						price:
							trade.price,

						zone:
							newZone,

						message:
							error instanceof Error
								? error.message
								: String(
										error,
									),
					}),
				);


				// Záměrně zde NEMĚNÍME alertStates.
			}

		} finally {
			this.alertProcessing.delete(
				trade.symbol,
			);
		}
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


		// ----------------------------------------------
		// OPEN
		// ----------------------------------------------

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


		// ----------------------------------------------
		// MESSAGE
		// ----------------------------------------------

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


		// ----------------------------------------------
		// CLOSE
		// ----------------------------------------------

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


		// ----------------------------------------------
		// ERROR
		// ----------------------------------------------

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
