import {
	routePartykitRequest,
	Server,
	type Connection,
} from "partyserver";
import { Chat } from "../server/index";

type EmailMode =
	| "success"
	| "retryable_failure"
	| "permanent_failure";

type ControlMessage = {
	action:
		| "set_email_mode"
		| "set_alert"
		| "set_alert_boundary"
		| "set_alert_enabled"
		| "delete_alert"
		| "trade"
		| "state";
	symbol?: string;
	below?: number | null;
	above?: number | null;
	enabled?: boolean;
	boundary?: "below" | "above";
	value?: number | null;
	price?: number;
	volume?: number;
	timestamp?: number;
	mode?: EmailMode;
};

const EMAIL_MODE_KEY = "b2_staging_email_mode";
const B2_SYMBOL = "B2TEST";

function authorizedConnection(): Connection {
	return {
		send() {},
	} as Connection;
}

function ownKeys(message: ControlMessage) {
	return Object.keys(message);
}

function isFiniteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value);
}

function validateControlMessage(
	message: unknown,
) {
	if (
		!message ||
		typeof message !== "object" ||
		Array.isArray(message)
	) {
		return "Payload must be an object";
	}

	const candidate =
		message as Record<string, unknown>;
	const action = candidate.action;

	if (typeof action !== "string") {
		return "Missing action";
	}

	const keys = ownKeys(
		candidate as ControlMessage,
	);
	const requireKeys = (
		expected: string[],
	) => {
		if (
			keys.length !== expected.length ||
			!expected.every((key) =>
				keys.includes(key),
			)
		) {
			return "Unexpected or missing payload fields";
		}

		return null;
	};

	if (action === "set_email_mode") {
		const fieldsError = requireKeys([
			"action",
			"mode",
		]);
		if (fieldsError) {
			return fieldsError;
		}
		if (
			candidate.mode !== "success" &&
			candidate.mode !== "retryable_failure" &&
			candidate.mode !== "permanent_failure"
		) {
			return "Invalid email mode";
		}
		return null;
	}

	if (action === "set_alert") {
		if (
			!keys.includes("action") ||
			!keys.includes("below") ||
			!keys.includes("above") ||
			keys.some((key) =>
				!["action", "below", "above", "enabled"].includes(key),
			)
		) {
			return "Unexpected or missing payload fields";
		}
		if (
			candidate.enabled !== undefined &&
			typeof candidate.enabled !== "boolean"
		) {
			return "Invalid enabled value";
		}
		if (
			candidate.below !== null &&
			(!isFiniteNumber(candidate.below) ||
				(candidate.below as number) <= 0)
		) {
			return "Invalid below boundary";
		}
		if (
			candidate.above !== null &&
			(!isFiniteNumber(candidate.above) ||
				(candidate.above as number) <= 0)
		) {
			return "Invalid above boundary";
		}
		if (
			candidate.below !== null &&
			candidate.above !== null &&
			(candidate.below as number) >=
				(candidate.above as number)
		) {
			return "Invalid alert range";
		}
		return null;
	}

	if (action === "set_alert_boundary") {
		const fieldsError = requireKeys([
			"action",
			"boundary",
			"value",
		]);
		if (fieldsError) {
			return fieldsError;
		}
		if (
			candidate.boundary !== "below" &&
			candidate.boundary !== "above"
		) {
			return "Invalid boundary";
		}
		if (
			candidate.value !== null &&
			(!isFiniteNumber(candidate.value) ||
				(candidate.value as number) <= 0)
		) {
			return "Invalid boundary value";
		}
		return null;
	}

	if (action === "set_alert_enabled") {
		const fieldsError = requireKeys([
			"action",
			"enabled",
		]);
		if (fieldsError) {
			return fieldsError;
		}
		return typeof candidate.enabled ===
			"boolean"
			? null
			: "Invalid enabled value";
	}

	if (action === "delete_alert" || action === "state") {
		return requireKeys(["action"]);
	}

	if (action === "trade") {
		const fieldsError = requireKeys([
			"action",
			"price",
			"volume",
			"timestamp",
		]);
		if (fieldsError) {
			return fieldsError;
		}
		if (
			!isFiniteNumber(candidate.price) ||
			(candidate.price as number) <= 0
		) {
			return "Invalid price";
		}
		if (
			!isFiniteNumber(candidate.volume) ||
			(candidate.volume as number) < 0
		) {
			return "Invalid volume";
		}
		if (
			!isFiniteNumber(candidate.timestamp) ||
			(candidate.timestamp as number) <= 0
		) {
			return "Invalid timestamp";
		}
		return null;
	}

	return "Unknown action";
}

export class B2StagingChat extends Chat {
	static options = {
		hibernate: true,
	};

	constructor(
		ctx: DurableObjectState,
		env: Env,
	) {
		super(ctx, env);

		this.emailSender = async () => {
			const mode =
				await this.ctx.storage.get<EmailMode>(
					EMAIL_MODE_KEY,
				);

			if (mode === "retryable_failure") {
				throw new Error(
					"Gmail API HTTP 503: staging failure",
				);
			}

			if (mode === "permanent_failure") {
				throw new Error(
					"Gmail API HTTP 400: staging failure",
				);
			}

			return "b2-staging-message";
		};
	}

	async onStart() {
		await this.loadState();

		await this.onMessage(
			authorizedConnection(),
			JSON.stringify({
				type: "set_symbols",
				symbols: [B2_SYMBOL],
			}),
		);
	}

	async onRequest(request: Request) {
		if (
			new URL(request.url).pathname !==
			"/__b2-test/control" ||
			request.headers.get("x-b2-staging-authorized") !== "1"
		) {
			return new Response("Not found", { status: 404 });
		}

		let message: ControlMessage;
		try {
			message = await request.json() as ControlMessage;
		} catch {
			return Response.json(
				{ error: "Invalid JSON" },
				{ status: 400 },
			);
		}

		const validationError =
			validateControlMessage(message);
		if (validationError) {
			return Response.json(
				{ error: validationError },
				{ status: 400 },
			);
		}

		if (message.action === "state") {
			return Response.json({
				alerts: await this.ctx.storage.get(
					"price_alerts",
				),
				runtime: await this.ctx.storage.get(
					"alert_runtime_v2",
				),
			});
		}

		if (message.action === "set_email_mode") {
			await this.ctx.storage.put(
				EMAIL_MODE_KEY,
				message.mode,
			);

			return Response.json({ ok: true });
		}

		const connection =
			authorizedConnection();

		if (message.action === "set_alert") {
			await this.onMessage(
				connection,
				JSON.stringify({
					type: "set_alert",
					symbol: B2_SYMBOL,
					below: message.below ?? null,
					above: message.above ?? null,
					enabled: message.enabled ?? true,
				}),
			);
		} else if (
			message.action ===
			"set_alert_boundary"
		) {
			await this.onMessage(
				connection,
				JSON.stringify({
					type: "set_alert_boundary",
					symbol: B2_SYMBOL,
					boundary: message.boundary,
					value: message.value ?? null,
					requestId: "staging",
				}),
			);
		} else if (
			message.action ===
			"set_alert_enabled"
		) {
			await this.onMessage(
				connection,
				JSON.stringify({
					type: "set_alert_enabled",
					symbol: B2_SYMBOL,
					enabled: message.enabled ?? true,
					requestId: "staging",
				}),
			);
		} else if (message.action === "delete_alert") {
			await this.onMessage(
				connection,
				JSON.stringify({
					type: "delete_alert",
					symbol: B2_SYMBOL,
				}),
			);
		} else if (message.action === "trade") {
			await this.handleTrade({
				symbol: B2_SYMBOL,
				price: message.price,
				volume: message.volume ?? 1,
				timestamp:
					message.timestamp ?? Date.now(),
			});
		} else {
			return Response.json(
				{ error: "Unknown action" },
				{ status: 400 },
			);
		}

		return Response.json({ ok: true });
	}
}

export default {
	async fetch(
		request: Request,
		env: B2StagingEnv,
	) {
		const pathname = new URL(
			request.url,
		).pathname;

		if (
			pathname === "/__b2-test/control" &&
			request.method !== "POST"
		) {
			return new Response(
				"Method Not Allowed",
				{
					status: 405,
					headers: {
						Allow: "POST",
					},
				},
			);
		}

		if (
			pathname === "/__b2-test/control"
		) {
			const authorization =
				request.headers.get(
					"Authorization",
				);
			const expected =
				env.STAGING_TEST_TOKEN;

			if (
				!expected ||
				authorization !==
					`Bearer ${expected}`
			) {
				return new Response(
					"Unauthorized",
					{ status: 401 },
				);
			}

			const body =
				await request.text();
			let parsed: ControlMessage;
			try {
				parsed = JSON.parse(body) as ControlMessage;
			} catch {
				return new Response(
					"Invalid JSON",
					{ status: 400 },
				);
			}

			const room =
				request.headers.get(
					"x-b2-staging-room",
				);
			if (!room) {
				return new Response(
					"Missing staging room",
					{ status: 400 },
				);
			}

			const forwardedHeaders =
				new Headers(request.headers);
			forwardedHeaders.delete(
				"Authorization",
			);
			forwardedHeaders.delete(
				"x-partykit-room",
			);
			forwardedHeaders.delete(
				"x-partykit-namespace",
			);
			forwardedHeaders.set(
				"x-b2-staging-authorized",
				"1",
			);

			const partyRequest =
				new Request(
					`https://staging.internal/parties/b2-staging-chat/${encodeURIComponent(
						room,
					)}`,
					{
						method: "POST",
						headers: forwardedHeaders,
						body: JSON.stringify(parsed),
					},
				);

			return routePartykitRequest(
				partyRequest,
				{
					B2StagingChat:
						env.B2StagingChat,
				},
				{
					onBeforeRequest: (
						requestWithMetadata,
					) =>
						new Request(
							"https://staging.internal/__b2-test/control",
							requestWithMetadata,
						),
				},
			);
		}

		return (
			await routePartykitRequest(
				request,
				{
					B2StagingChat:
						env.B2StagingChat,
				},
			) ??
			new Response("Not found", { status: 404 })
		);
	},
} satisfies ExportedHandler<B2StagingEnv>;
