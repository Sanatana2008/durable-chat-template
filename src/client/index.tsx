import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState } from "react";

const SYMBOLS = ["AAPL", "NVDA", "MSFT"];

type StockData = {
	symbol: string;
	price: number | null;
	volume: number | null;
	timestamp: number | null;
};

type TradeMessage = {
	type: "trade";
	symbol: string;
	price: number;
	volume: number;
	timestamp: number;
	conditions?: string[];
};

type StatusMessage = {
	type: "status";
	status: "connected" | "connecting" | "disconnected";
	symbols?: string[];
};

type ServerMessage = TradeMessage | StatusMessage;

function formatPrice(price: number | null) {
	if (price === null) {
		return "—";
	}

	return price.toFixed(2);
}

function formatTime(timestamp: number | null) {
	if (!timestamp) {
		return "—";
	}

	return new Date(timestamp).toLocaleTimeString("cs-CZ", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function App() {
	const [connectionStatus, setConnectionStatus] =
		useState<"connected" | "connecting" | "disconnected">("connecting");

	const [stocks, setStocks] = useState<Record<string, StockData>>(() => {
		const initial: Record<string, StockData> = {};

		for (const symbol of SYMBOLS) {
			initial[symbol] = {
				symbol,
				price: null,
				volume: null,
				timestamp: null,
			};
		}

		return initial;
	});

	usePartySocket({
		party: "chat",

		// DŮLEŽITÉ:
		// Všichni používají jediný Durable Object.
		room: "stocks",

		onOpen: () => {
			setConnectionStatus("connecting");
		},

		onClose: () => {
			setConnectionStatus("disconnected");
		},

		onMessage: (event) => {
			try {
				const message = JSON.parse(event.data as string) as ServerMessage;

				if (message.type === "status") {
					setConnectionStatus(message.status);
					return;
				}

				if (message.type === "trade") {
					setConnectionStatus("connected");

					setStocks((previous) => ({
						...previous,

						[message.symbol]: {
							symbol: message.symbol,
							price: message.price,
							volume: message.volume,
							timestamp: message.timestamp,
						},
					}));
				}
			} catch (error) {
				console.error("WebSocket message error:", error);
			}
		},
	});

	const statusText =
		connectionStatus === "connected"
			? "Připojeno k Finnhubu"
			: connectionStatus === "connecting"
				? "Připojuji se…"
				: "Odpojeno – čekám na obnovení spojení";

	return (
		<div
			style={{
				maxWidth: "900px",
				margin: "60px auto",
				padding: "0 20px",
				fontFamily:
					'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
				color: "#111827",
			}}
		>
			<div
				style={{
					marginBottom: "32px",
				}}
			>
				<h1
					style={{
						fontSize: "32px",
						marginBottom: "8px",
					}}
				>
					Stocktrade Live
				</h1>

				<p
					style={{
						margin: 0,
						color:
							connectionStatus === "connected"
								? "#15803d"
								: connectionStatus === "disconnected"
									? "#b91c1c"
									: "#a16207",
						fontWeight: 600,
					}}
				>
					● {statusText}
				</p>
			</div>

			<div
				style={{
					border: "1px solid #e5e7eb",
					borderRadius: "12px",
					overflow: "hidden",
					boxShadow: "0 4px 18px rgba(0,0,0,0.05)",
				}}
			>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1.2fr 1fr 1fr 1fr",
						padding: "14px 18px",
						background: "#f3f4f6",
						fontWeight: 700,
						fontSize: "14px",
					}}
				>
					<div>Ticker</div>
					<div>Cena</div>
					<div>Volume</div>
					<div>Poslední tick</div>
				</div>

				{SYMBOLS.map((symbol) => {
					const stock = stocks[symbol];

					return (
						<div
							key={symbol}
							style={{
								display: "grid",
								gridTemplateColumns: "1.2fr 1fr 1fr 1fr",
								padding: "18px",
								borderTop: "1px solid #e5e7eb",
								alignItems: "center",
							}}
						>
							<div
								style={{
									fontWeight: 800,
									fontSize: "18px",
								}}
							>
								{symbol}
							</div>

							<div
								style={{
									fontWeight: 700,
									fontSize: "18px",
								}}
							>
								{stock.price === null
									? "Čekám…"
									: `$${formatPrice(stock.price)}`}
							</div>

							<div>
								{stock.volume === null ? "—" : stock.volume}
							</div>

							<div
								style={{
									color: "#6b7280",
								}}
							>
								{formatTime(stock.timestamp)}
							</div>
						</div>
					);
				})}
			</div>

			<p
				style={{
					marginTop: "18px",
					fontSize: "13px",
					color: "#6b7280",
				}}
			>
				Ceny jsou přijímány živě přes Finnhub WebSocket a Cloudflare Durable
				Object.
			</p>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
