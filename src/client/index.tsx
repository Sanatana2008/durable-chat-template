import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useMemo, useState } from "react";

const SYMBOLS = ["AAPL", "NVDA", "MSFT"];

type StockData = {
	symbol: string;
	price: number | null;
	volume: number | null;
	timestamp: number | null;
	firstPrice: number | null;
	history: number[];
};

type TradeMessage = {
	type: "trade";
	symbol: string;
	price: number;
	volume: number;
	timestamp: number;
};

type StatusMessage = {
	type: "status";
	status: "connected" | "connecting" | "disconnected";
	symbols?: string[];
};

type ServerMessage = TradeMessage | StatusMessage;

function formatPrice(price: number | null) {
	if (price === null) return "—";
	return `$${price.toFixed(2)}`;
}

function formatTime(timestamp: number | null) {
	if (!timestamp) return "—";

	return new Date(timestamp).toLocaleTimeString("cs-CZ", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function MiniChart({ values }: { values: number[] }) {
	if (values.length < 2) {
		return (
			<div
				style={{
					height: 280,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					color: "#64748b",
				}}
			>
				Čekám na další ticková data…
			</div>
		);
	}

	const width = 800;
	const height = 260;
	const padding = 12;

	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;

	const points = values
		.map((value, index) => {
			const x =
				padding +
				(index / Math.max(values.length - 1, 1)) *
					(width - padding * 2);

			const y =
				height -
				padding -
				((value - min) / range) *
					(height - padding * 2);

			return `${x},${y}`;
		})
		.join(" ");

	return (
		<div style={{ width: "100%", overflow: "hidden" }}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				style={{
					width: "100%",
					height: 280,
					display: "block",
				}}
			>
				<line
					x1="0"
					y1={height / 2}
					x2={width}
					y2={height / 2}
					stroke="#1e293b"
					strokeWidth="1"
				/>

				<polyline
					points={points}
					fill="none"
					stroke="currentColor"
					strokeWidth="3"
					strokeLinejoin="round"
					strokeLinecap="round"
				/>
			</svg>
		</div>
	);
}

function App() {
	const [selectedSymbol, setSelectedSymbol] = useState("AAPL");

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
				firstPrice: null,
				history: [],
			};
		}

		return initial;
	});

	usePartySocket({
		party: "chat",
		room: "stocks",

		onOpen: () => {
			setConnectionStatus("connecting");
		},

		onClose: () => {
			setConnectionStatus("disconnected");
		},

		onMessage: (event) => {
			try {
				const message = JSON.parse(
					event.data as string,
				) as ServerMessage;

				if (message.type === "status") {
					setConnectionStatus(message.status);
					return;
				}

				if (message.type === "trade") {
					setConnectionStatus("connected");

					setStocks((previous) => {
						const old =
							previous[message.symbol] ?? {
								symbol: message.symbol,
								price: null,
								volume: null,
								timestamp: null,
								firstPrice: null,
								history: [],
							};

						const history = [
							...old.history,
							message.price,
						].slice(-120);

						return {
							...previous,

							[message.symbol]: {
								...old,
								price: message.price,
								volume: message.volume,
								timestamp: message.timestamp,
								firstPrice:
									old.firstPrice ??
									message.price,
								history,
							},
						};
					});
				}
			} catch (error) {
				console.error(
					"WebSocket message error:",
					error,
				);
			}
		},
	});

	const selected = stocks[selectedSymbol];

	const change = useMemo(() => {
		if (
			!selected?.price ||
			!selected.firstPrice
		) {
			return {
				value: null,
				percent: null,
			};
		}

		const value =
			selected.price -
			selected.firstPrice;

		const percent =
			(value /
				selected.firstPrice) *
			100;

		return {
			value,
			percent,
		};
	}, [selected]);

	const positive =
		change.value !== null &&
		change.value >= 0;

	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#020617",
				color: "#e2e8f0",
				fontFamily:
					'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			}}
		>
			<header
				style={{
					height: 64,
					borderBottom:
						"1px solid #1e293b",
					display: "flex",
					alignItems: "center",
					justifyContent:
						"space-between",
					padding: "0 28px",
					background: "#0f172a",
				}}
			>
				<div>
					<div
						style={{
							fontSize: 20,
							fontWeight: 800,
						}}
					>
						Stocktrade Live
					</div>

					<div
						style={{
							fontSize: 12,
							color: "#64748b",
						}}
					>
						Finnhub realtime market feed
					</div>
				</div>

				<div
					style={{
						fontSize: 13,
						fontWeight: 600,
						color:
							connectionStatus ===
							"connected"
								? "#22c55e"
								: connectionStatus ===
									  "disconnected"
									? "#ef4444"
									: "#f59e0b",
					}}
				>
					●{" "}
					{connectionStatus ===
					"connected"
						? "LIVE"
						: connectionStatus ===
							  "connecting"
							? "CONNECTING"
							: "DISCONNECTED"}
				</div>
			</header>

			<div
				style={{
					display: "grid",
					gridTemplateColumns:
						"260px minmax(0, 1fr) 300px",
					minHeight:
						"calc(100vh - 64px)",
				}}
			>
				<aside
					style={{
						borderRight:
							"1px solid #1e293b",
						background: "#0b1120",
						padding: 18,
					}}
				>
					<div
						style={{
							fontSize: 12,
							fontWeight: 700,
							color: "#64748b",
							letterSpacing: 1,
							marginBottom: 14,
						}}
					>
						WATCHLIST
					</div>

					{SYMBOLS.map((symbol) => {
						const stock =
							stocks[symbol];

						const selectedRow =
							symbol ===
							selectedSymbol;

						return (
							<button
								key={symbol}
								onClick={() =>
									setSelectedSymbol(
										symbol,
									)
								}
								style={{
									width: "100%",
									border: "none",
									borderRadius: 8,
									background:
										selectedRow
											? "#1e293b"
											: "transparent",
									color: "#e2e8f0",
									padding:
										"12px 10px",
									marginBottom: 6,
									cursor: "pointer",
									textAlign: "left",
								}}
							>
								<div
									style={{
										display:
											"flex",
										justifyContent:
											"space-between",
										alignItems:
											"center",
									}}
								>
									<strong>
										{symbol}
									</strong>

									<span>
										{stock.price ===
										null
											? "—"
											: stock.price.toFixed(
													2,
												)}
									</span>
								</div>

								<div
									style={{
										fontSize: 11,
										color: "#64748b",
										marginTop: 3,
									}}
								>
									{formatTime(
										stock.timestamp,
									)}
								</div>
							</button>
						);
					})}
				</aside>

				<main
					style={{
						padding: "28px 32px",
						minWidth: 0,
					}}
				>
					<div
						style={{
							display: "flex",
							justifyContent:
								"space-between",
							alignItems:
								"flex-start",
							marginBottom: 28,
						}}
					>
						<div>
							<div
								style={{
									fontSize: 14,
									color: "#64748b",
									marginBottom: 6,
								}}
							>
								NASDAQ
							</div>

							<h1
								style={{
									fontSize: 32,
									margin: 0,
								}}
							>
								{selectedSymbol}
							</h1>
						</div>

						<div
							style={{
								textAlign: "right",
							}}
						>
							<div
								style={{
									fontSize: 34,
									fontWeight: 800,
								}}
							>
								{formatPrice(
									selected?.price ??
										null,
								)}
							</div>

							<div
								style={{
									fontSize: 14,
									fontWeight: 700,
									marginTop: 4,
									color:
										change.value ===
										null
											? "#64748b"
											: positive
												? "#22c55e"
												: "#ef4444",
								}}
							>
								{change.value ===
								null
									? "Čekám na data"
									: `${positive ? "+" : ""}${change.value.toFixed(2)} (${positive ? "+" : ""}${change.percent?.toFixed(2)}%)`}
							</div>
						</div>
					</div>

					<section
						style={{
							border:
								"1px solid #1e293b",
							borderRadius: 12,
							background: "#0f172a",
							padding: 20,
							color:
								positive
									? "#22c55e"
									: "#ef4444",
						}}
					>
						<MiniChart
							values={
								selected?.history ??
								[]
							}
						/>
					</section>

					<div
						style={{
							display: "grid",
							gridTemplateColumns:
								"repeat(3, 1fr)",
							gap: 14,
							marginTop: 18,
						}}
					>
						<div style={statBox}>
							<div style={statLabel}>
								LAST PRICE
							</div>
							<div style={statValue}>
								{formatPrice(
									selected?.price ??
										null,
								)}
							</div>
						</div>

						<div style={statBox}>
							<div style={statLabel}>
								LAST VOLUME
							</div>
							<div style={statValue}>
								{selected?.volume ??
									"—"}
							</div>
						</div>

						<div style={statBox}>
							<div style={statLabel}>
								LAST TICK
							</div>
							<div style={statValue}>
								{formatTime(
									selected?.timestamp ??
										null,
								)}
							</div>
						</div>
					</div>
				</main>

				<aside
					style={{
						borderLeft:
							"1px solid #1e293b",
						background: "#0b1120",
						padding: 20,
					}}
				>
					<div
						style={{
							fontSize: 12,
							fontWeight: 700,
							color: "#64748b",
							letterSpacing: 1,
							marginBottom: 18,
						}}
					>
						TRADE PANEL
					</div>

					<div
						style={{
							fontSize: 24,
							fontWeight: 800,
							marginBottom: 20,
						}}
					>
						{selectedSymbol}
					</div>

					<button
						disabled
						style={{
							...tradeButton,
							background: "#166534",
						}}
					>
						BUY
					</button>

					<button
						disabled
						style={{
							...tradeButton,
							background: "#991b1b",
						}}
					>
						SELL
					</button>

					<p
						style={{
							fontSize: 12,
							color: "#64748b",
							lineHeight: 1.6,
							marginTop: 18,
						}}
					>
						Obchodování je zatím
						vypnuté. Tento panel nyní
						slouží pouze jako náhled
						budoucí funkce.
					</p>
				</aside>
			</div>
		</div>
	);
}

const statBox: React.CSSProperties = {
	border: "1px solid #1e293b",
	background: "#0f172a",
	borderRadius: 10,
	padding: 16,
};

const statLabel: React.CSSProperties = {
	fontSize: 11,
	color: "#64748b",
	fontWeight: 700,
	letterSpacing: 0.8,
	marginBottom: 8,
};

const statValue: React.CSSProperties = {
	fontSize: 18,
	fontWeight: 800,
};

const tradeButton: React.CSSProperties = {
	width: "100%",
	border: "none",
	color: "white",
	fontWeight: 800,
	fontSize: 15,
	padding: "14px 18px",
	borderRadius: 8,
	marginBottom: 12,
	opacity: 0.65,
	cursor: "not-allowed",
};

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
