import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

const SYMBOLS = ["AAPL", "NVDA", "MSFT"];

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
};

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	private finnhubSocket: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	onStart() {
		this.connectFinnhub();
	}

	private connectFinnhub() {
		if (
			this.finnhubSocket &&
			(this.finnhubSocket.readyState === WebSocket.OPEN ||
				this.finnhubSocket.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		const apiKey = this.env.FINNHUB_API_KEY;

		if (!apiKey) {
			console.error("FINNHUB_API_KEY is missing");
			return;
		}

		console.log("Connecting to Finnhub...");

		const ws = new WebSocket(
			`wss://ws.finnhub.io?token=${encodeURIComponent(apiKey)}`,
		);

		this.finnhubSocket = ws;

		ws.addEventListener("open", () => {
			console.log("Finnhub WebSocket connected");

			for (const symbol of SYMBOLS) {
				ws.send(
					JSON.stringify({
						type: "subscribe",
						symbol,
					}),
				);
			}

			this.broadcast(
				JSON.stringify({
					type: "status",
					status: "connected",
					symbols: SYMBOLS,
				}),
			);
		});

		ws.addEventListener("message", (event) => {
			try {
				const message = JSON.parse(event.data as string) as FinnhubMessage;

				if (message.type !== "trade" || !message.data) {
					return;
				}

				for (const trade of message.data) {
					const payload = {
						type: "trade",
						symbol: trade.s,
						price: trade.p,
						volume: trade.v,
						timestamp: trade.t,
						conditions: trade.c ?? [],
					};

					console.log(
						`${payload.symbol}: ${payload.price} volume=${payload.volume}`,
					);

					this.broadcast(JSON.stringify(payload));
				}
			} catch (error) {
				console.error("Finnhub message error:", error);
			}
		});

		ws.addEventListener("close", (event) => {
			console.log(
				`Finnhub WebSocket closed: ${event.code} ${event.reason}`,
			);

			this.finnhubSocket = null;

			this.broadcast(
				JSON.stringify({
					type: "status",
					status: "disconnected",
				}),
			);

			this.scheduleReconnect();
		});

		ws.addEventListener("error", (event) => {
			console.error("Finnhub WebSocket error:", event);
		});
	}

	private scheduleReconnect() {
		if (this.reconnectTimer) {
			return;
		}

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connectFinnhub();
		}, 5000);
	}

	onConnect(connection: Connection) {
		connection.send(
			JSON.stringify({
				type: "status",
				status:
					this.finnhubSocket?.readyState === WebSocket.OPEN
						? "connected"
						: "connecting",
				symbols: SYMBOLS,
			}),
		);

		this.connectFinnhub();
	}

	onMessage(_connection: Connection, message: WSMessage) {
		console.log("Client message:", message);
	}
}

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(request, { ...env })) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
