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
const ALERT_RUNTIME_STORAGE_KEY = "alert_runtime_v2";

const PRICE_SAVE_INTERVAL_MS = 60_000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DELIVERY_LEASE_MS = 2 * 60 * 1000;
const DELIVERY_RETRY_DELAYS_MS = [
	30_000,
	2 * 60_000,
	10 * 60_000,
	30 * 60_000,
];


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

type DeliveryZone =
	| "below"
	| "above";

type DeliveryStatus =
	| "pending"
	| "sending"
	| "sent"
	| "failed";

type DeliveryRecord = {
	triggerId: string;
	symbol: string;
	zone: DeliveryZone;
	price: number;
	boundary: number;
	triggeredAt: number;
	status: DeliveryStatus;
	attempts: number;
	nextRetryAt: number | null;
	lastError: string | null;
	lastAttemptAt: number | null;
	completedAt: number | null;
	leaseExpiresAt: number | null;
	messageId: string | null;
};

type EmailSender = (
	subject: string,
	text: string,
) => Promise<string>;

type EmailErrorCode =
	| "gmail_oauth_configuration"
	| "gmail_token_request_failed"
	| "gmail_token_response_invalid"
	| "gmail_recipient_configuration"
	| "gmail_send_request_failed"
	| "gmail_send_response_invalid"
	| "email_delivery_temporarily_unavailable"
	| "email_delivery_failed";

class EmailDeliveryError extends Error {
	constructor(
		readonly code: EmailErrorCode,
		message: string,
		readonly retryable: boolean,
		readonly httpStatus?: number,
	) {
		super(message);
	}
}

type AlertRuntimeState = {
	version: 2;
	alertStates: Record<string, AlertZone>;
	deliveries: Record<string, DeliveryRecord>;
	nextTriggerSequence: number;
};

type AlertErrorCode =
	| "unknown_symbol"
	| "invalid_boundary"
	| "invalid_value"
	| "invalid_range"
	| "not_found";

type AlertCommand =
	| "set_alert_boundary"
	| "set_alert_enabled";

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
			type: "set_alert_boundary";
			symbol: string;
			boundary: "below" | "above";
			value: number | null;
			requestId?: string;
	  }
	| {
			type: "set_alert_enabled";
			symbol: string;
			enabled: boolean;
			requestId?: string;
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

	private deliveryRecords =
		new Map<
			string,
			DeliveryRecord
		>();

	private nextTriggerSequence = 1;

	protected emailSender: EmailSender = (
		subject,
		text,
	) => this.sendEmail(subject, text);

	private clock = () => Date.now();

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


	async onAlarm() {
		await this.loadState();

		const now = this.clock();
		let runtimeChanged = false;
		const recoveredDeliveries: DeliveryRecord[] = [];

		for (const delivery of this.deliveryRecords.values()) {
			if (
				delivery.status !== "sending" ||
				delivery.leaseExpiresAt === null ||
				delivery.leaseExpiresAt > now
			) {
				continue;
			}

			delivery.leaseExpiresAt = null;
			delivery.lastError =
				"Delivery attempt interrupted before completion.";

			if (delivery.attempts >= 5) {
				delivery.status = "failed";
				delivery.nextRetryAt = null;
				delivery.completedAt = now;
			} else {
				delivery.status = "pending";
				delivery.nextRetryAt = now;
			}

			recoveredDeliveries.push(
				delivery,
			);

			runtimeChanged = true;
		}

		for (const [
			triggerId,
			delivery,
		] of this.deliveryRecords) {
			if (
				(delivery.status === "sent" ||
					delivery.status === "failed") &&
				delivery.completedAt !== null &&
				delivery.completedAt <=
					now - DELIVERY_RETENTION_MS
			) {
				this.deliveryRecords.delete(
					triggerId,
				);
				runtimeChanged = true;
			}
		}

		if (runtimeChanged) {
			await this.saveAlertStates();

			for (const delivery of recoveredDeliveries) {
				this.broadcastDeliveryStatus(
					delivery,
				);
			}
		}

		const dueDeliveries =
			Array.from(
				this.deliveryRecords.values(),
			).filter(
				(delivery) =>
					delivery.status === "pending" &&
					(delivery.nextRetryAt === null ||
						delivery.nextRetryAt <= now),
			);

		for (const delivery of dueDeliveries) {
			await this.processDelivery(
				delivery.triggerId,
			);
		}

		await this.scheduleDeliveryAlarm(
			this.clock(),
		);
	}


	// ==================================================
	// LOAD STATE
	// ==================================================

	protected async loadState() {
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
					AlertRuntimeState
				>(
					ALERT_RUNTIME_STORAGE_KEY,
				);

			if (saved?.version === 2) {
				for (
					const [
						symbol,
						zone,
					]
					of Object.entries(
						saved.alertStates ?? {},
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

				for (
					const [
						triggerId,
						delivery,
					]
					of Object.entries(
						saved.deliveries ?? {},
					)
				) {
					if (
						delivery &&
						(
							delivery.zone ===
								"below" ||
							delivery.zone ===
								"above"
						) &&
						(
							delivery.status ===
								"pending" ||
							delivery.status ===
								"sending" ||
							delivery.status ===
								"sent" ||
							delivery.status ===
								"failed"
						)
					) {
						this.deliveryRecords.set(
						triggerId,
						delivery,
						);
					}
				}

				if (
					Number.isInteger(
						saved.nextTriggerSequence,
					) &&
					saved.nextTriggerSequence > 0
				) {
					this.nextTriggerSequence =
						saved.nextTriggerSequence;
				}

				console.log(
					`Alert runtime restored: ${this.alertStates.size} states, ${this.deliveryRecords.size} deliveries`,
				);

				return;
			}

			const legacy =
				await this.ctx.storage.get<
					Record<
						string,
						AlertZone
					>
				>(
					ALERT_STATES_STORAGE_KEY,
				);

			if (legacy) {
				for (
					const [
						symbol,
						zone,
					]
					of Object.entries(
						legacy,
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

				await this.saveAlertStates();
			}

			console.log(
				`Alert runtime restored: ${this.alertStates.size} states, 0 deliveries`,
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
			const alertStates: Record<
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
				alertStates[symbol] =
					zone;
			}

			const deliveries: Record<
				string,
				DeliveryRecord
			> = {};

			for (
				const [
					triggerId,
					delivery,
				]
				of this.deliveryRecords
			) {
				deliveries[triggerId] =
					delivery;
			}

			await this.ctx.storage.put(
				ALERT_RUNTIME_STORAGE_KEY,
				{
					version: 2,
					alertStates,
					deliveries,
					nextTriggerSequence:
						this.nextTriggerSequence,
				} satisfies AlertRuntimeState,
			);

		} catch (error) {
			console.error(
				"Alert states save error:",
				error,
			);

			throw error;
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
			throw new EmailDeliveryError(
				"gmail_oauth_configuration",
				"Missing Gmail OAuth secrets.",
				false,
			);
		}

		let response: Response;
		try {
			response = await fetch(
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
			} catch {
				this.logEmailFailure(
					"gmail_token_request",
					"gmail_token_request_failed",
				);
				throw new EmailDeliveryError(
					"gmail_token_request_failed",
					"Email delivery temporarily unavailable.",
					true,
				);
			}

		if (!response.ok) {
				const retryable =
					this.isRetryableHttpStatus(
						response.status,
					);
				this.logEmailFailure(
					"gmail_token_request",
					"gmail_token_request_failed",
					response.status,
				);
				throw new EmailDeliveryError(
					"gmail_token_request_failed",
					retryable
						? "Email delivery temporarily unavailable."
						: "Gmail token request failed.",
					retryable,
					response.status,
			);
		}

			let data: { access_token?: string };
			try {
				data = await response.json() as {
					access_token?: string;
				};
			} catch {
				this.logEmailFailure(
					"gmail_token_response",
					"gmail_token_response_invalid",
				);
				throw new EmailDeliveryError(
					"gmail_token_response_invalid",
					"Gmail token request failed.",
					false,
				);
			}

		if (
			!data.access_token
		) {
				this.logEmailFailure(
					"gmail_token_response",
					"gmail_token_response_invalid",
				);
				throw new EmailDeliveryError(
					"gmail_token_response_invalid",
					"Gmail token request failed.",
					false,
			);
		}


		return data.access_token;
	}


	// ==================================================
	// GMAIL SEND
	// ==================================================

	protected async sendEmail(
		subject: string,
		text: string,
	) {
		const recipient =
			this.env.ALERT_EMAIL_TO;

		if (!recipient) {
			throw new EmailDeliveryError(
				"gmail_recipient_configuration",
				"Missing ALERT_EMAIL_TO secret.",
				false,
			);
		}

		const accessToken =
			await this.getGmailAccessToken();


		const email =
			"From: Stocktrade Alerts\r\n" +
			`To: ${recipient}\r\n` +
			`Subject: ${subject}\r\n` +
			`MIME-Version: 1.0\r\n` +
			`Content-Type: text/plain; charset=UTF-8\r\n` +
			`Content-Transfer-Encoding: 8bit\r\n` +
			`\r\n` +
			text;


		const raw =
			toBase64Url(email);


		let response: Response;
		try {
			response = await fetch(
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
			} catch {
				this.logEmailFailure(
					"gmail_send",
					"gmail_send_request_failed",
				);
				throw new EmailDeliveryError(
					"gmail_send_request_failed",
					"Email delivery temporarily unavailable.",
					true,
				);
			}

		if (!response.ok) {
				const retryable =
					this.isRetryableHttpStatus(
						response.status,
					);
				this.logEmailFailure(
					"gmail_send",
					"gmail_send_request_failed",
					response.status,
				);
				throw new EmailDeliveryError(
					"gmail_send_request_failed",
					retryable
						? "Email delivery temporarily unavailable."
						: "Gmail send request failed.",
					retryable,
					response.status,
			);
		}

			let data: { id?: string };
			try {
				data = await response.json() as {
					id?: string;
				};
			} catch {
				this.logEmailFailure(
					"gmail_send_response",
					"gmail_send_response_invalid",
				);
				throw new EmailDeliveryError(
					"gmail_send_response_invalid",
					"Gmail send request failed.",
					false,
				);
			}

		if (!data.id) {
				this.logEmailFailure(
					"gmail_send_response",
					"gmail_send_response_invalid",
				);
				throw new EmailDeliveryError(
					"gmail_send_response_invalid",
					"Gmail send request failed.",
					false,
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


    private async loadInitialQuote(symbol: string) {
        if (this.latestTrades.has(symbol)) {
            return;
        }

        const apiKey = this.env.FINNHUB_API_KEY;

        if (!apiKey) {
            return;
        }

        try {
            const response = await fetch(
                `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`,
            );

            if (!response.ok) {
                console.warn(
                    `Finnhub quote fallback failed for ${symbol}: HTTP ${response.status}`,
                );
                return;
            }

            const quote = await response.json() as {
                c?: number;
                t?: number;
            };

            if (
                typeof quote.c !== "number" ||
                !Number.isFinite(quote.c) ||
                quote.c <= 0
            ) {
                console.warn(
                    `Finnhub quote fallback returned no usable price for ${symbol}`,
                );
                return;
            }

            const timestamp =
                typeof quote.t === "number" &&
                Number.isFinite(quote.t) &&
                quote.t > 0
                    ? quote.t * 1000
                    : this.clock();

            await this.handleTrade({
                symbol,
                price: quote.c,
                volume: 0,
                timestamp,
            });

            console.log(
                `Finnhub quote fallback loaded: ${symbol} = ${quote.c}`,
            );
        } catch (error) {
            console.error(
                `Finnhub quote fallback error for ${symbol}:`,
                error,
            );
        }
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

			void this.loadInitialQuote(symbol);
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


	private createDeliveryStatusPayload(
		delivery: DeliveryRecord,
	) {
		return {
			type:
				"alert_delivery_status",
			symbol:
				delivery.symbol,
			zone:
				delivery.zone,
			triggerId:
				delivery.triggerId,
			status:
				delivery.status,
			attempts:
				delivery.attempts,
			nextRetryAt:
				delivery.nextRetryAt,
			lastError:
				delivery.lastError,
			triggeredAt:
				delivery.triggeredAt,
		};
	}


	private broadcastDeliveryStatus(
		delivery: DeliveryRecord,
	) {
		this.broadcast(
			JSON.stringify(
				this.createDeliveryStatusPayload(
					delivery,
				),
			),
		);
	}


	private async scheduleDeliveryAlarm(
		now: number,
	) {
		let nextAlarmAt:
			| number
			| null = null;

		for (const delivery of this.deliveryRecords.values()) {
			const candidate =
				delivery.status === "pending"
					? delivery.nextRetryAt ?? now
					: delivery.status === "sending"
						? delivery.leaseExpiresAt
						: null;

			if (candidate === null) {
				continue;
			}

			const normalizedCandidate =
				Math.max(candidate, now);

			if (
				nextAlarmAt === null ||
				normalizedCandidate < nextAlarmAt
			) {
				nextAlarmAt = normalizedCandidate;
			}
		}

		if (nextAlarmAt !== null) {
			await this.ctx.storage.setAlarm(
				nextAlarmAt,
			);
		}
	}


	private logEmailFailure(
		operation: string,
		code: EmailErrorCode,
		httpStatus?: number,
	) {
		console.error(
			"Email delivery failure",
			{
				operation,
				code,
				httpStatus,
			},
		);
	}


	private isRetryableHttpStatus(
		httpStatus: number,
	) {
		return (
			httpStatus === 408 ||
			httpStatus === 429 ||
			httpStatus >= 500
		);
	}


	private toPublicEmailError(
		error: unknown,
	) {
		if (error instanceof EmailDeliveryError) {
			return error;
		}

		const message =
			error instanceof Error
				? error.message
				: String(error);
		const retryable =
			/HTTP (408|429|5\d\d)\b/.test(
				message,
			) ||
			/Failed to fetch|NetworkError|network|timeout/i.test(
				message,
			);

		return new EmailDeliveryError(
			retryable
				? "email_delivery_temporarily_unavailable"
				: "email_delivery_failed",
			retryable
				? "Email delivery temporarily unavailable."
				: "Email delivery failed.",
			retryable,
		);
	}


	private async processDelivery(
		triggerId: string,
	) {
		const delivery =
			this.deliveryRecords.get(
				triggerId,
			);

		if (
			!delivery ||
			delivery.status !== "pending"
		) {
			return;
		}

		delivery.status = "sending";
		delivery.attempts += 1;
			delivery.lastAttemptAt =
				this.clock();
		delivery.leaseExpiresAt =
			delivery.lastAttemptAt +
			DELIVERY_LEASE_MS;
		delivery.nextRetryAt = null;

		await this.saveAlertStates();
		this.broadcastDeliveryStatus(
			delivery,
		);

		try {
			const messageId =
				await this.sendPriceAlertEmail(
					delivery,
				);

			delivery.status = "sent";
			delivery.lastError = null;
			delivery.nextRetryAt = null;
			delivery.leaseExpiresAt = null;
			delivery.completedAt =
				this.clock();
			delivery.messageId =
				messageId;

			await this.saveAlertStates();
			this.broadcastDeliveryStatus(
				delivery,
			);
		} catch (error) {
			const deliveryError =
				this.toPublicEmailError(
					error,
				);
			const message =
				deliveryError.message;
			const retryable =
				deliveryError.retryable;

			if (
				retryable &&
				delivery.attempts < 5
			) {
				delivery.status = "pending";
					delivery.nextRetryAt =
					this.clock() +
					(
						DELIVERY_RETRY_DELAYS_MS[
							delivery.attempts - 1
						] ??
						DELIVERY_RETRY_DELAYS_MS[
							DELIVERY_RETRY_DELAYS_MS.length -
								1
						]
					);
				delivery.completedAt = null;
			} else {
				delivery.status = "failed";
				delivery.nextRetryAt = null;
				delivery.completedAt =
					this.clock();
			}

			delivery.lastError = message;
			delivery.leaseExpiresAt = null;

			await this.saveAlertStates();
			this.broadcastDeliveryStatus(
				delivery,
			);

			this.broadcast(
				JSON.stringify({
					type:
						"alert_email_error",
					symbol:
						delivery.symbol,
					price:
						delivery.price,
					zone:
						delivery.zone,
					code:
						deliveryError.code,
					message,
				}),
			);
		}
	}


	private sendAlertError(
		connection: Connection,
		symbol: string,
		code: AlertErrorCode,
		message: string,
		requestId?: string,
	) {
		connection.send(
			JSON.stringify({
				type: "alert_error",
				requestId,
				symbol,
				code,
				message,
			}),
		);
	}


	private sendAlertCommandAck(
		connection: Connection,
		requestId: string,
		symbol: string,
		command: AlertCommand,
	) {
		connection.send(
			JSON.stringify({
				type: "alert_command_ack",
				requestId,
				symbol,
				command,
			}),
		);
	}


	private async setAlertBoundary(
		connection: Connection,
		symbolRaw: string,
		boundaryRaw: "below" | "above",
		value: number | null,
		requestId?: string,
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
			this.sendAlertError(
				connection,
				symbol,
				"unknown_symbol",
				`Alert ignored: ${symbol} is not in watchlist`,
				requestId,
			);

			return;
		}

		if (
			boundaryRaw !== "below" &&
			boundaryRaw !== "above"
		) {
			this.sendAlertError(
				connection,
				symbol,
				"invalid_boundary",
				`Invalid boundary: ${String(
					boundaryRaw,
				)}`,
				requestId,
			);

			return;
		}

		const currentAlert =
			this.alerts.get(
				symbol,
			);

		if (!currentAlert) {
			this.sendAlertError(
				connection,
				symbol,
				"not_found",
				`Alert not found for ${symbol}`,
				requestId,
			);

			return;
		}

		const nextAlert: PriceAlert = {
			symbol,
			below:
				currentAlert.below,
			above:
				currentAlert.above,
			enabled:
				currentAlert.enabled,
		};

		if (
			value === null
		) {
			if (
				boundaryRaw ===
				"below"
			) {
				nextAlert.below =
					null;
			} else {
				nextAlert.above =
					null;
			}
		} else {
			if (
				typeof value !==
					"number" ||
				!Number.isFinite(
					value,
				) ||
				value <= 0
			) {
				this.sendAlertError(
					connection,
					symbol,
					"invalid_value",
					`Invalid boundary value for ${symbol}: ${String(
						value,
					)}`,
					requestId,
				);

				return;
			}

			if (
				boundaryRaw ===
				"below"
			) {
				nextAlert.below =
					value;
			} else {
				nextAlert.above =
					value;
			}
		}

		if (
			nextAlert.below === null &&
			nextAlert.above === null
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

			if (requestId) {
				this.sendAlertCommandAck(
					connection,
					requestId,
					symbol,
					"set_alert_boundary",
				);
			}

			return;
		}

		if (
			nextAlert.below !== null &&
			nextAlert.above !== null &&
			nextAlert.below >=
				nextAlert.above
		) {
			this.sendAlertError(
				connection,
				symbol,
				"invalid_range",
				`Invalid alert range for ${symbol}: below=${nextAlert.below}, above=${nextAlert.above}`,
				requestId,
			);

			return;
		}

		this.alerts.set(
			symbol,
			nextAlert,
		);

		const latest =
			this.latestTrades.get(
				symbol,
			);

		if (latest) {
			const currentZone =
				this.getAlertZone(
					nextAlert,
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
		this.broadcastAlerts();

		if (requestId) {
			this.sendAlertCommandAck(
				connection,
				requestId,
				symbol,
				"set_alert_boundary",
			);
		}
	}


	private async setAlertEnabled(
		connection: Connection,
		symbolRaw: string,
		enabled: boolean,
		requestId?: string,
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
			this.sendAlertError(
				connection,
				symbol,
				"unknown_symbol",
				`Alert ignored: ${symbol} is not in watchlist`,
				requestId,
			);

			return;
		}

		const currentAlert =
			this.alerts.get(
				symbol,
			);

		if (!currentAlert) {
			this.sendAlertError(
				connection,
				symbol,
				"not_found",
				`Alert not found for ${symbol}`,
				requestId,
			);

			return;
		}

		const nextAlert: PriceAlert = {
			symbol,
			below:
				currentAlert.below,
			above:
				currentAlert.above,
			enabled,
		};

		this.alerts.set(
			symbol,
			nextAlert,
		);

		if (!enabled) {
			this.alertStates.delete(
				symbol,
			);
			await this.saveAlerts();
			await this.saveAlertStates();
			this.broadcastAlerts();

			if (requestId) {
				this.sendAlertCommandAck(
					connection,
					requestId,
					symbol,
					"set_alert_enabled",
				);
			}

			return;
		}

		const latest =
			this.latestTrades.get(
				symbol,
			);

		if (latest) {
			const currentZone =
				this.getAlertZone(
					nextAlert,
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
		this.broadcastAlerts();

		if (requestId) {
			this.sendAlertCommandAck(
				connection,
				requestId,
				symbol,
				"set_alert_enabled",
			);
		}
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
		delivery: DeliveryRecord,
	) {
		const directionText =
			delivery.zone === "below"
				? "klesl pod nastavenou hranici"
				: "vzrostl nad nastavenou hranici";


		const subject =
			`Stocktrade Alert - ${delivery.symbol}`;


		const text =
			"Stocktrade Alerts\n\n" +

			`${delivery.symbol} ${directionText}.\n\n` +

			`Aktuální cena: ${delivery.price} USD\n` +

			`Hranice: ${delivery.boundary} USD\n` +

			`Směr: ${delivery.zone.toUpperCase()}\n\n` +

			`Čas trhu: ${new Date(
				delivery.triggeredAt,
			).toISOString()}\n` +

			`Odesláno: ${new Date(
				this.clock(),
			).toISOString()}\n\n` +

			"Stocktrade Live";


		return await this.emailSender(
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

			if (boundary === null) {
				return;
			}

			const cooldownCutoff =
				this.clock() - ALERT_COOLDOWN_MS;

			const recentSameZoneDelivery =
				Array.from(
					this.deliveryRecords.values(),
				).some(
					(delivery) =>
						delivery.symbol === trade.symbol &&
						delivery.zone === newZone &&
						delivery.triggeredAt >= cooldownCutoff,
				);

			if (recentSameZoneDelivery) {
				this.alertStates.set(
					trade.symbol,
					newZone,
				);

				await this.saveAlertStates();

				console.log(
					`${trade.symbol}: alert suppressed by 5-minute cooldown (${newZone})`,
				);

				return;
			}


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


			const triggerId =
				`${trade.symbol}:${this.nextTriggerSequence}`;

			this.nextTriggerSequence += 1;
			this.alertStates.set(
				trade.symbol,
				newZone,
			);

			const delivery: DeliveryRecord = {
				triggerId,
				symbol: trade.symbol,
				zone: newZone,
				price: trade.price,
				boundary,
				triggeredAt: trade.timestamp,
				status: "pending",
				attempts: 0,
				nextRetryAt: null,
				lastError: null,
				lastAttemptAt: null,
				completedAt: null,
				leaseExpiresAt: null,
				messageId: null,
			};

			this.deliveryRecords.set(
				triggerId,
				delivery,
			);

			await this.saveAlertStates();
			await this.ctx.storage.setAlarm(
				this.clock(),
			);

			this.broadcast(
				JSON.stringify(
					alertPayload,
				),
			);
			this.broadcastDeliveryStatus(
				delivery,
			);

		} finally {
			this.alertProcessing.delete(
				trade.symbol,
			);
		}
	}


	protected async handleTrade(
		latest: LatestTrade,
		conditions: string[] = [],
	) {
		this.latestTrades.set(
			latest.symbol,
			latest,
		);

		this.schedulePriceSave();

		this.broadcast(
			JSON.stringify({
				type:
					"trade",
				...latest,
				conditions,
			}),
		);

		await this.processPriceAlert(
			latest,
		);
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


							void this.handleTrade(
								latest,
								trade.c ??
									[],
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
				"set_alert_boundary"
			) {
				await this.setAlertBoundary(
					connection,
					message.symbol,
					message.boundary,
					message.value,
					message.requestId,
				);

				return;
			}


			if (
				message.type ===
				"set_alert_enabled"
			) {
				await this.setAlertEnabled(
					connection,
					message.symbol,
					message.enabled,
					message.requestId,
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
