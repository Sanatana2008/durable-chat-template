import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, {
	useEffect,
	useMemo,
	useState,
} from "react";

const DEFAULT_SYMBOLS = ["AAPL", "NVDA", "MSFT"];
const DEFAULT_MAX_SYMBOLS = 40;


// ======================================================
// TYPES
// ======================================================

type StockData = {
	symbol: string;
	price: number | null;
	volume: number | null;
	timestamp: number | null;
	firstPrice: number | null;
	history: number[];
};

type PriceAlert = {
	symbol: string;
	below: number | null;
	above: number | null;
	enabled: boolean;
};

type TradeMessage = {
	type: "trade";
	symbol: string;
	price: number;
	volume: number;
	timestamp: number;
};

type SnapshotTrade = {
	symbol: string;
	price: number;
	volume: number;
	timestamp: number;
};

type SnapshotMessage = {
	type: "snapshot";
	trades: SnapshotTrade[];
};

type StatusMessage = {
	type: "status";
	status:
		| "connected"
		| "connecting"
		| "disconnected"
		| "error";
	symbols?: string[];
	maxSymbols?: number;
	message?: string;
};

type SymbolsMessage = {
	type: "symbols";
	symbols: string[];
	maxSymbols: number;
};

type AlertsMessage = {
	type: "alerts";
	alerts: PriceAlert[];
};

type PriceAlertMessage = {
	type: "price_alert";
	symbol: string;
	zone: "below" | "above";
	price: number;
	boundary: number | null;
	timestamp: number;
};

type AlertResetMessage = {
	type: "alert_reset";
	symbol: string;
	price: number;
};

type FinnhubErrorMessage = {
	type: "finnhub_error";
	message: string;
};

type ServerMessage =
	| TradeMessage
	| SnapshotMessage
	| StatusMessage
	| SymbolsMessage
	| AlertsMessage
	| PriceAlertMessage
	| AlertResetMessage
	| FinnhubErrorMessage;


// ======================================================
// HELPERS
// ======================================================

function createEmptyStock(
	symbol: string,
): StockData {
	return {
		symbol,
		price: null,
		volume: null,
		timestamp: null,
		firstPrice: null,
		history: [],
	};
}


function formatPrice(
	price: number | null,
) {
	if (price === null) {
		return "—";
	}

	return `$${price.toFixed(2)}`;
}


function formatTime(
	timestamp: number | null,
) {
	if (!timestamp) {
		return "—";
	}

	return new Date(
		timestamp,
	).toLocaleTimeString(
		"cs-CZ",
		{
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		},
	);
}


function normalizeSymbol(
	value: string,
) {
	return value
		.trim()
		.toUpperCase();
}


function validSymbol(
	value: string,
) {
	return /^[A-Z0-9.\-:]{1,20}$/.test(
		value,
	);
}


function parseAlertNumber(
	value: string,
): number | null {
	const trimmed =
		value.trim();

	if (!trimmed) {
		return null;
	}

	const parsed =
		Number(trimmed);

	if (
		!Number.isFinite(parsed) ||
		parsed <= 0
	) {
		return null;
	}

	return parsed;
}


// ======================================================
// MINI CHART
// ======================================================

function MiniChart({
	values,
}: {
	values: number[];
}) {
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

	const min =
		Math.min(...values);

	const max =
		Math.max(...values);

	const range =
		max - min || 1;

	const points =
		values
			.map(
				(
					value,
					index,
				) => {
					const x =
						padding +
						(index /
							Math.max(
								values.length - 1,
								1,
							)) *
							(width -
								padding * 2);

					const y =
						height -
						padding -
						((value - min) /
							range) *
							(height -
								padding * 2);

					return `${x},${y}`;
				},
			)
			.join(" ");

	return (
		<div
			style={{
				width: "100%",
				overflow: "hidden",
			}}
		>
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


// ======================================================
// APP
// ======================================================

function App() {
	const [
		symbols,
		setSymbols,
	] = useState<string[]>(
		DEFAULT_SYMBOLS,
	);

	const [
		maxSymbols,
		setMaxSymbols,
	] = useState(
		DEFAULT_MAX_SYMBOLS,
	);

	const [
		selectedSymbol,
		setSelectedSymbol,
	] = useState("AAPL");

	const [
		newSymbol,
		setNewSymbol,
	] = useState("");

	const [
		watchlistError,
		setWatchlistError,
	] = useState<
		string | null
	>(null);

	const [
		connectionStatus,
		setConnectionStatus,
	] = useState<
		| "connected"
		| "connecting"
		| "disconnected"
		| "error"
	>("connecting");

	const [
		serverError,
		setServerError,
	] = useState<
		string | null
	>(null);

	const [
		stocks,
		setStocks,
	] = useState<
		Record<
			string,
			StockData
		>
	>(() => {
		const initial: Record<
			string,
			StockData
		> = {};

		for (
			const symbol
			of DEFAULT_SYMBOLS
		) {
			initial[symbol] =
				createEmptyStock(
					symbol,
				);
		}

		return initial;
	});


	// ==================================================
	// ALERT STATE
	// ==================================================

	const [
		alerts,
		setAlerts,
	] = useState<
		Record<
			string,
			PriceAlert
		>
	>({});

	const [
		belowInput,
		setBelowInput,
	] = useState("");

	const [
		aboveInput,
		setAboveInput,
	] = useState("");

	const [
		alertFormError,
		setAlertFormError,
	] = useState<
		string | null
	>(null);

	const [
		alertFormMessage,
		setAlertFormMessage,
	] = useState<
		string | null
	>(null);

	const [
		lastTriggeredAlert,
		setLastTriggeredAlert,
	] = useState<
		PriceAlertMessage | null
	>(null);


	// ==================================================
	// SYMBOLS
	// ==================================================

	function applyServerSymbols(
		nextSymbols: string[],
	) {
		if (
			!nextSymbols.length
		) {
			return;
		}

		setSymbols(
			nextSymbols,
		);

		setStocks(
			(previous) => {
				const updated = {
					...previous,
				};

				for (
					const symbol
					of nextSymbols
				) {
					if (
						!updated[
							symbol
						]
					) {
						updated[
							symbol
						] =
							createEmptyStock(
								symbol,
							);
					}
				}

				return updated;
			},
		);
	}


	// ==================================================
	// SNAPSHOT
	// ==================================================

	function applySnapshot(
		trades: SnapshotTrade[],
	) {
		if (
			!trades.length
		) {
			return;
		}

		setStocks(
			(previous) => {
				const updated = {
					...previous,
				};

				for (
					const trade
					of trades
				) {
					const old =
						updated[
							trade.symbol
						] ??
						createEmptyStock(
							trade.symbol,
						);

					updated[
						trade.symbol
					] = {
						...old,

						price:
							trade.price,

						volume:
							trade.volume,

						timestamp:
							trade.timestamp,

						firstPrice:
							old.firstPrice ??
							trade.price,

						history:
							old.history
								.length > 0
								? old.history
								: [
										trade.price,
									],
					};
				}

				return updated;
			},
		);
	}


	// ==================================================
	// ALERT LIST FROM SERVER
	// ==================================================

	function applyAlerts(
		serverAlerts: PriceAlert[],
	) {
		const next: Record<
			string,
			PriceAlert
		> = {};

		for (
			const alert
			of serverAlerts
		) {
			next[
				alert.symbol
			] = alert;
		}

		setAlerts(next);
	}


	// ==================================================
	// WEBSOCKET
	// ==================================================

	const socket =
		usePartySocket({
			party: "chat",

			room: "stocks",

			onOpen: () => {
				setConnectionStatus(
					"connecting",
				);

				setServerError(
					null,
				);
			},

			onClose: () => {
				setConnectionStatus(
					"disconnected",
				);
			},

			onMessage: (
				event,
			) => {
				try {
					const message =
						JSON.parse(
							event.data as string,
						) as ServerMessage;


					// ------------------------------
					// STATUS
					// ------------------------------

					if (
						message.type ===
						"status"
					) {
						setConnectionStatus(
							message.status,
						);

						if (
							message.maxSymbols
						) {
							setMaxSymbols(
								message.maxSymbols,
							);
						}

						if (
							message.symbols
						) {
							applyServerSymbols(
								message.symbols,
							);
						}

						if (
							message.message
						) {
							setServerError(
								message.message,
							);
						}

						return;
					}


					// ------------------------------
					// SYMBOLS
					// ------------------------------

					if (
						message.type ===
						"symbols"
					) {
						setMaxSymbols(
							message.maxSymbols,
						);

						applyServerSymbols(
							message.symbols,
						);

						return;
					}


					// ------------------------------
					// SNAPSHOT
					// ------------------------------

					if (
						message.type ===
						"snapshot"
					) {
						applySnapshot(
							message.trades,
						);

						return;
					}


					// ------------------------------
					// ALERT SETTINGS
					// ------------------------------

					if (
						message.type ===
						"alerts"
					) {
						applyAlerts(
							message.alerts,
						);

						return;
					}


					// ------------------------------
					// REAL PRICE ALERT
					// ------------------------------

					if (
						message.type ===
						"price_alert"
					) {
						setLastTriggeredAlert(
							message,
						);

						return;
					}


					// ------------------------------
					// ALERT RESET
					// ------------------------------

					if (
						message.type ===
						"alert_reset"
					) {
						return;
					}


					// ------------------------------
					// FINNHUB ERROR
					// ------------------------------

					if (
						message.type ===
						"finnhub_error"
					) {
						setServerError(
							message.message,
						);

						return;
					}


					// ------------------------------
					// LIVE TRADE
					// ------------------------------

					if (
						message.type ===
						"trade"
					) {
						setConnectionStatus(
							"connected",
						);

						setStocks(
							(
								previous,
							) => {
								const old =
									previous[
										message.symbol
									] ??
									createEmptyStock(
										message.symbol,
									);

								const history =
									[
										...old.history,
										message.price,
									].slice(
										-120,
									);

								return {
									...previous,

									[
										message.symbol
									]:
										{
											...old,

											price:
												message.price,

											volume:
												message.volume,

											timestamp:
												message.timestamp,

											firstPrice:
												old.firstPrice ??
												message.price,

											history,
										},
								};
							},
						);
					}

				} catch (
					error
				) {
					console.error(
						"WebSocket message error:",
						error,
					);
				}
			},
		});


	// ==================================================
	// SELECTED SYMBOL
	// ==================================================

	useEffect(() => {
		if (
			symbols.length > 0 &&
			!symbols.includes(
				selectedSymbol,
			)
		) {
			setSelectedSymbol(
				symbols[0],
			);
		}
	}, [
		symbols,
		selectedSymbol,
	]);


	// ==================================================
	// LOAD ALERT FORM WHEN SYMBOL CHANGES
	// ==================================================

	useEffect(() => {
		const alert =
			alerts[
				selectedSymbol
			];

		if (alert) {
			setBelowInput(
				alert.below ===
				null
					? ""
					: String(
							alert.below,
						),
			);

			setAboveInput(
				alert.above ===
				null
					? ""
					: String(
							alert.above,
						),
			);

		} else {
			setBelowInput("");
			setAboveInput("");
		}

		setAlertFormError(
			null,
		);

		setAlertFormMessage(
			null,
		);

	}, [
		selectedSymbol,
		alerts,
	]);


	const selected =
		stocks[
			selectedSymbol
		] ??
		createEmptyStock(
			selectedSymbol,
		);


	const selectedAlert =
		alerts[
			selectedSymbol
		] ?? null;


	// ==================================================
	// PRICE CHANGE
	// ==================================================

	const change =
		useMemo(() => {
			if (
				selected.price ===
					null ||
				selected.firstPrice ===
					null
			) {
				return {
					value: null,
					percent:
						null,
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
		change.value !==
			null &&
		change.value >= 0;


	// ==================================================
	// WATCHLIST COMMANDS
	// ==================================================

	function sendSymbols(
		nextSymbols: string[],
	) {
		socket.send(
			JSON.stringify({
				type:
					"set_symbols",

				symbols:
					nextSymbols,
			}),
		);
	}


	function addSymbol() {
		setWatchlistError(
			null,
		);

		const symbol =
			normalizeSymbol(
				newSymbol,
			);

		if (!symbol) {
			return;
		}

		if (
			!validSymbol(
				symbol,
			)
		) {
			setWatchlistError(
				"Neplatný ticker.",
			);

			return;
		}

		if (
			symbols.includes(
				symbol,
			)
		) {
			setWatchlistError(
				`${symbol} už ve watchlistu je.`,
			);

			return;
		}

		if (
			symbols.length >=
			maxSymbols
		) {
			setWatchlistError(
				`Maximum je ${maxSymbols} tickerů.`,
			);

			return;
		}

		const nextSymbols =
			[
				...symbols,
				symbol,
			];

		setSymbols(
			nextSymbols,
		);

		setStocks(
			(previous) => ({
				...previous,

				[symbol]:
					previous[
						symbol
					] ??
					createEmptyStock(
						symbol,
					),
			}),
		);

		setSelectedSymbol(
			symbol,
		);

		setNewSymbol("");

		sendSymbols(
			nextSymbols,
		);
	}


	function removeSymbol(
		symbolToRemove: string,
	) {
		setWatchlistError(
			null,
		);

		if (
			symbols.length <=
			1
		) {
			setWatchlistError(
				"Ve watchlistu musí zůstat alespoň jeden ticker.",
			);

			return;
		}

		const nextSymbols =
			symbols.filter(
				(symbol) =>
					symbol !==
					symbolToRemove,
			);

		setSymbols(
			nextSymbols,
		);

		if (
			selectedSymbol ===
			symbolToRemove
		) {
			setSelectedSymbol(
				nextSymbols[0],
			);
		}

		sendSymbols(
			nextSymbols,
		);
	}


	// ==================================================
	// SAVE ALERT
	// ==================================================

	function saveAlert() {
		setAlertFormError(
			null,
		);

		setAlertFormMessage(
			null,
		);

		const below =
			parseAlertNumber(
				belowInput,
			);

		const above =
			parseAlertNumber(
				aboveInput,
			);


		if (
			belowInput.trim() &&
			below === null
		) {
			setAlertFormError(
				"Below musí být kladné číslo.",
			);

			return;
		}


		if (
			aboveInput.trim() &&
			above === null
		) {
			setAlertFormError(
				"Above musí být kladné číslo.",
			);

			return;
		}


		if (
			below === null &&
			above === null
		) {
			setAlertFormError(
				"Zadej alespoň jednu hranici.",
			);

			return;
		}


		if (
			below !== null &&
			above !== null &&
			below >= above
		) {
			setAlertFormError(
				"Below musí být nižší než Above.",
			);

			return;
		}


		socket.send(
			JSON.stringify({
				type:
					"set_alert",

				symbol:
					selectedSymbol,

				below,

				above,

				enabled:
					true,
			}),
		);


		setAlertFormMessage(
			`Alert pro ${selectedSymbol} uložen.`,
		);
	}


	// ==================================================
	// DELETE ALERT
	// ==================================================

	function deleteAlert() {
		setAlertFormError(
			null,
		);

		socket.send(
			JSON.stringify({
				type:
					"delete_alert",

				symbol:
					selectedSymbol,
			}),
		);

		setBelowInput("");

		setAboveInput("");

		setAlertFormMessage(
			`Alert pro ${selectedSymbol} odstraněn.`,
		);
	}


	// ==================================================
	// STATUS
	// ==================================================

	const statusColor =
		connectionStatus ===
		"connected"
			? "#22c55e"
			: connectionStatus ===
				  "disconnected"
				? "#ef4444"
				: connectionStatus ===
					  "error"
					? "#ef4444"
					: "#f59e0b";


	const statusText =
		connectionStatus ===
		"connected"
			? "LIVE"
			: connectionStatus ===
				  "connecting"
				? "CONNECTING"
				: connectionStatus ===
					  "error"
					? "ERROR"
					: "DISCONNECTED";


	// ==================================================
	// RENDER
	// ==================================================

	return (
		<div
			style={{
				minHeight:
					"100vh",

				background:
					"#020617",

				color:
					"#e2e8f0",

				fontFamily:
					'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			}}
		>

			{/* HEADER */}

			<header
				style={{
					height: 64,

					borderBottom:
						"1px solid #1e293b",

					display:
						"flex",

					alignItems:
						"center",

					justifyContent:
						"space-between",

					padding:
						"0 28px",

					background:
						"#0f172a",
				}}
			>
				<div>
					<div
						style={{
							fontSize:
								20,

							fontWeight:
								800,
						}}
					>
						Stocktrade Live
					</div>

					<div
						style={{
							fontSize:
								12,

							color:
								"#64748b",
						}}
					>
						Finnhub realtime market feed
					</div>
				</div>

				<div
					style={{
						fontSize:
							13,

						fontWeight:
							700,

						color:
							statusColor,
					}}
				>
					● {statusText}
				</div>
			</header>


			{/* PRICE ALERT BANNER */}

			{lastTriggeredAlert && (
				<div
					style={{
						background:
							lastTriggeredAlert.zone ===
							"above"
								? "#052e16"
								: "#450a0a",

						borderBottom:
							lastTriggeredAlert.zone ===
							"above"
								? "1px solid #166534"
								: "1px solid #991b1b",

						padding:
							"10px 28px",

						display:
							"flex",

						alignItems:
							"center",

						justifyContent:
							"space-between",

						fontSize:
							13,

						fontWeight:
							700,
					}}
				>
					<div>
						PRICE ALERT:{" "}

						{lastTriggeredAlert.symbol}{" "}

						{lastTriggeredAlert.zone ===
						"above"
							? "vzrostl"
							: "klesl"}{" "}

						na{" "}

						{formatPrice(
							lastTriggeredAlert.price,
						)}

						{" "}— hranice{" "}

						{formatPrice(
							lastTriggeredAlert.boundary,
						)}
					</div>

					<button
						onClick={() =>
							setLastTriggeredAlert(
								null,
							)
						}
						style={{
							border:
								"none",

							background:
								"transparent",

							color:
								"#cbd5e1",

							cursor:
								"pointer",

							fontSize:
								18,
						}}
					>
						×
					</button>
				</div>
			)}


			{/* MAIN GRID */}

			<div
				style={{
					display:
						"grid",

					gridTemplateColumns:
						"280px minmax(0, 1fr) 320px",

					minHeight:
						lastTriggeredAlert
							? "calc(100vh - 105px)"
							: "calc(100vh - 64px)",
				}}
			>

				{/* WATCHLIST */}

				<aside
					style={{
						borderRight:
							"1px solid #1e293b",

						background:
							"#0b1120",

						padding:
							18,

						overflowY:
							"auto",
					}}
				>
					<div
						style={{
							display:
								"flex",

							alignItems:
								"center",

							justifyContent:
								"space-between",

							marginBottom:
								14,
						}}
					>
						<div
							style={{
								fontSize:
									12,

								fontWeight:
									700,

								color:
									"#64748b",

								letterSpacing:
									1,
							}}
						>
							WATCHLIST
						</div>

						<div
							style={{
								fontSize:
									11,

								fontWeight:
									700,

								color:
									"#94a3b8",
							}}
						>
							{symbols.length} / {maxSymbols}
						</div>
					</div>


					{/* ADD SYMBOL */}

					<div
						style={{
							display:
								"flex",

							gap:
								6,

							marginBottom:
								8,
						}}
					>
						<input
							value={
								newSymbol
							}

							onChange={(
								event,
							) =>
								setNewSymbol(
									event.target.value,
								)
							}

							onKeyDown={(
								event,
							) => {
								if (
									event.key ===
									"Enter"
								) {
									event.preventDefault();

									addSymbol();
								}
							}}

							placeholder="TSLA"

							maxLength={
								20
							}

							style={{
								flex:
									1,

								minWidth:
									0,

								background:
									"#020617",

								border:
									"1px solid #334155",

								color:
									"#e2e8f0",

								borderRadius:
									7,

								padding:
									"9px 10px",

								fontWeight:
									700,

								textTransform:
									"uppercase",

								outline:
									"none",
							}}
						/>

						<button
							onClick={
								addSymbol
							}

							disabled={
								symbols.length >=
								maxSymbols
							}

							style={{
								border:
									"none",

								borderRadius:
									7,

								background:
									"#2563eb",

								color:
									"white",

								fontWeight:
									800,

								padding:
									"0 12px",

								cursor:
									symbols.length >=
									maxSymbols
										? "not-allowed"
										: "pointer",

								opacity:
									symbols.length >=
									maxSymbols
										? 0.5
										: 1,
							}}
						>
							+
						</button>
					</div>


					{watchlistError && (
						<div
							style={{
								fontSize:
									11,

								color:
									"#f87171",

								marginBottom:
									10,
							}}
						>
							{watchlistError}
						</div>
					)}


					{/* SYMBOL ROWS */}

					{symbols.map(
						(
							symbol,
						) => {
							const stock =
								stocks[
									symbol
								] ??
								createEmptyStock(
									symbol,
								);

							const selectedRow =
								symbol ===
								selectedSymbol;

							const hasAlert =
								Boolean(
									alerts[
										symbol
									],
								);

							return (
								<div
									key={
										symbol
									}

									style={{
										position:
											"relative",

										marginBottom:
											6,
									}}
								>
									<button
										onClick={() =>
											setSelectedSymbol(
												symbol,
											)
										}

										style={{
											width:
												"100%",

											border:
												"none",

											borderRadius:
												8,

											background:
												selectedRow
													? "#1e293b"
													: "transparent",

											color:
												"#e2e8f0",

											padding:
												"12px 34px 12px 10px",

											cursor:
												"pointer",

											textAlign:
												"left",
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
											<div
												style={{
													display:
														"flex",

													alignItems:
														"center",

													gap:
														6,
												}}
											>
												<strong>
													{symbol}
												</strong>

												{hasAlert && (
													<span
														title="Aktivní cenový alert"

														style={{
															width:
																7,

															height:
																7,

															borderRadius:
																"50%",

															background:
																"#f59e0b",

															display:
																"inline-block",
														}}
													/>
												)}
											</div>

											<span
												style={{
													fontWeight:
														700,
												}}
											>
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
												fontSize:
													11,

												color:
													"#64748b",

												marginTop:
													3,
											}}
										>
											{formatTime(
												stock.timestamp,
											)}
										</div>
									</button>

									<button
										onClick={() =>
											removeSymbol(
												symbol,
											)
										}

										title={`Odebrat ${symbol}`}

										style={{
											position:
												"absolute",

											right:
												7,

											top:
												8,

											width:
												23,

											height:
												23,

											border:
												"none",

											borderRadius:
												6,

											background:
												"transparent",

											color:
												"#64748b",

											cursor:
												"pointer",

											fontSize:
												16,
										}}
									>
										×
									</button>
								</div>
							);
						},
					)}
				</aside>


				{/* MAIN MARKET */}

				<main
					style={{
						padding:
							"28px 32px",

						minWidth:
							0,
					}}
				>
					{serverError && (
						<div
							style={{
								background:
									"#450a0a",

								border:
									"1px solid #7f1d1d",

								color:
									"#fecaca",

								borderRadius:
									8,

								padding:
									"10px 14px",

								marginBottom:
									18,

								fontSize:
									13,
							}}
						>
							Finnhub: {serverError}
						</div>
					)}


					<div
						style={{
							display:
								"flex",

							justifyContent:
								"space-between",

							alignItems:
								"flex-start",

							marginBottom:
								28,
						}}
					>
						<div>
							<div
								style={{
									fontSize:
										14,

									color:
										"#64748b",

									marginBottom:
										6,
								}}
							>
								MARKET
							</div>

							<h1
								style={{
									fontSize:
										32,

									margin:
										0,
								}}
							>
								{selectedSymbol}
							</h1>
						</div>

						<div
							style={{
								textAlign:
									"right",
							}}
						>
							<div
								style={{
									fontSize:
										34,

									fontWeight:
										800,
								}}
							>
								{formatPrice(
									selected.price,
								)}
							</div>

							<div
								style={{
									fontSize:
										14,

									fontWeight:
										700,

									marginTop:
										4,

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
									: `${positive ? "+" : ""}${change.value.toFixed(
											2,
										)} (${positive ? "+" : ""}${change.percent?.toFixed(
											2,
										)}%)`}
							</div>
						</div>
					</div>


					<section
						style={{
							border:
								"1px solid #1e293b",

							borderRadius:
								12,

							background:
								"#0f172a",

							padding:
								20,

							color:
								change.value ===
								null
									? "#64748b"
									: positive
										? "#22c55e"
										: "#ef4444",
						}}
					>
						<MiniChart
							values={
								selected.history
							}
						/>
					</section>


					<div
						style={{
							display:
								"grid",

							gridTemplateColumns:
								"repeat(3, 1fr)",

							gap:
								14,

							marginTop:
								18,
						}}
					>
						<div style={statBox}>
							<div style={statLabel}>
								LAST PRICE
							</div>

							<div style={statValue}>
								{formatPrice(
									selected.price,
								)}
							</div>
						</div>

						<div style={statBox}>
							<div style={statLabel}>
								LAST VOLUME
							</div>

							<div style={statValue}>
								{selected.volume ?? "—"}
							</div>
						</div>

						<div style={statBox}>
							<div style={statLabel}>
								LAST TICK
							</div>

							<div style={statValue}>
								{formatTime(
									selected.timestamp,
								)}
							</div>
						</div>
					</div>
				</main>


				{/* PRICE ALERT PANEL */}

				<aside
					style={{
						borderLeft:
							"1px solid #1e293b",

						background:
							"#0b1120",

						padding:
							20,
					}}
				>
					<div
						style={{
							fontSize:
								12,

							fontWeight:
								700,

							color:
								"#64748b",

							letterSpacing:
								1,

							marginBottom:
								18,
						}}
					>
						PRICE ALERTS
					</div>


					<div
						style={{
							fontSize:
								24,

							fontWeight:
								800,

							marginBottom:
								4,
						}}
					>
						{selectedSymbol}
					</div>


					<div
						style={{
							fontSize:
								18,

							fontWeight:
								700,

							color:
								"#94a3b8",

							marginBottom:
								22,
						}}
					>
						{formatPrice(
							selected.price,
						)}
					</div>


					{/* BELOW */}

					<label
						style={
							alertLabel
						}
					>
						Alert below
					</label>

					<input
						type="number"

						step="0.01"

						min="0"

						value={
							belowInput
						}

						onChange={(
							event,
						) =>
							setBelowInput(
								event.target.value,
							)
						}

						placeholder="např. 295"

						style={
							alertInput
						}
					/>


					{/* ABOVE */}

					<label
						style={
							alertLabel
						}
					>
						Alert above
					</label>

					<input
						type="number"

						step="0.01"

						min="0"

						value={
							aboveInput
						}

						onChange={(
							event,
						) =>
							setAboveInput(
								event.target.value,
							)
						}

						placeholder="např. 320"

						style={
							alertInput
						}
					/>


					{/* ERRORS */}

					{alertFormError && (
						<div
							style={{
								fontSize:
									12,

								color:
									"#f87171",

								marginBottom:
									12,
							}}
						>
							{alertFormError}
						</div>
					)}


					{alertFormMessage && (
						<div
							style={{
								fontSize:
									12,

								color:
									"#4ade80",

								marginBottom:
									12,
							}}
						>
							{alertFormMessage}
						</div>
					)}


					{/* SAVE */}

					<button
						onClick={
							saveAlert
						}

						style={{
							width:
								"100%",

							border:
								"none",

							color:
								"white",

							background:
								"#2563eb",

							fontWeight:
								800,

							fontSize:
								14,

							padding:
								"12px 16px",

							borderRadius:
								8,

							cursor:
								"pointer",

							marginBottom:
								10,
						}}
					>
						SAVE ALERT
					</button>


					{/* DELETE */}

					<button
						onClick={
							deleteAlert
						}

						disabled={
							!selectedAlert
						}

						style={{
							width:
								"100%",

							border:
								"1px solid #7f1d1d",

							color:
								selectedAlert
									? "#fca5a5"
									: "#475569",

							background:
								"transparent",

							fontWeight:
								700,

							fontSize:
								13,

							padding:
								"11px 16px",

							borderRadius:
								8,

							cursor:
								selectedAlert
									? "pointer"
									: "not-allowed",

							opacity:
								selectedAlert
									? 1
									: 0.55,
						}}
					>
						DELETE ALERT
					</button>


					{/* ACTIVE ALERT SUMMARY */}

					{selectedAlert && (
						<div
							style={{
								marginTop:
									22,

								border:
									"1px solid #334155",

								borderRadius:
									8,

								padding:
									14,

								background:
									"#0f172a",
							}}
						>
							<div
								style={{
									fontSize:
										11,

									color:
										"#64748b",

									fontWeight:
										700,

									letterSpacing:
										0.8,

									marginBottom:
										10,
								}}
							>
								ACTIVE ALERT
							</div>

							<div
								style={{
									fontSize:
										13,

									lineHeight:
										1.8,
								}}
							>
								<div>
									Below:{" "}
									<strong>
										{formatPrice(
											selectedAlert.below,
										)}
									</strong>
								</div>

								<div>
									Above:{" "}
									<strong>
										{formatPrice(
											selectedAlert.above,
										)}
									</strong>
								</div>
							</div>
						</div>
					)}


					<p
						style={{
							fontSize:
								12,

							color:
								"#64748b",

							lineHeight:
								1.6,

							marginTop:
								18,
						}}
					>
						Alert se aktivuje pouze při
						přechodu ceny přes nastavenou
						hranici. Opakované tickové ceny
						ve stejné zóně nevytvářejí další
						upozornění.
					</p>
				</aside>

			</div>
		</div>
	);
}


// ======================================================
// STYLES
// ======================================================

const statBox:
	React.CSSProperties = {
		border:
			"1px solid #1e293b",

		background:
			"#0f172a",

		borderRadius:
			10,

		padding:
			16,
	};


const statLabel:
	React.CSSProperties = {
		fontSize:
			11,

		color:
			"#64748b",

		fontWeight:
			700,

		letterSpacing:
			0.8,

		marginBottom:
			8,
	};


const statValue:
	React.CSSProperties = {
		fontSize:
			18,

		fontWeight:
			800,
	};


const alertLabel:
	React.CSSProperties = {
		display:
			"block",

		fontSize:
			11,

		color:
			"#94a3b8",

		fontWeight:
			700,

		marginBottom:
			6,

		textTransform:
			"uppercase",
	};


const alertInput:
	React.CSSProperties = {
		width:
			"100%",

		boxSizing:
			"border-box",

		background:
			"#020617",

		border:
			"1px solid #334155",

		color:
			"#e2e8f0",

		borderRadius:
			7,

		padding:
			"10px 11px",

		fontWeight:
			700,

		outline:
			"none",

		marginBottom:
			16,
	};


// ======================================================
// ROOT
// ======================================================

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(
	document.getElementById(
		"root",
	)!,
).render(<App />);
