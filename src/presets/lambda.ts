// SPDX-FileCopyrightText: 2026 Alexander R. Croft
// SPDX-License-Identifier: MIT

// lambda.ts
// AWS Lambda (Node) preset for Ratatouille.
//
// Goal: one install, minimal wiring.
// - Computes a stable-ish source identity from Lambda env vars.
// - Optionally ships envelopes to Ringtail (if RINGTAIL_URL is set).
// - Exposes a global topic factory usable from any file.

import Topic from "../topic";
import {
	createRingtailTransport,
	ringtailConfigFromEnv,
	type RingtailTransport,
	type RingtailTransportConfig,
	type SourceIdentity,
} from "../transports/ringtail";

type Json = Record<string, unknown>;

export type LambdaFactory = {
	topic: (name: string, meta?: Json) => ReturnType<typeof Topic>;
	initLogging: () => Promise<void>;
	sourceIdentity: () => SourceIdentity;
	transportStatus: () => ReturnType<RingtailTransport["status"]> | undefined;
};

export type LambdaFactoryOptions = {
	env?: Record<string, string | undefined>;
	enabled?: boolean;
	ringtailUrl?: string;
	ringtailToken?: string;
	src?: SourceIdentity;
	includeEnv?: boolean;
	alsoPrint?: boolean;
	transport?: Omit<RingtailTransportConfig, "url" | "token" | "src" | "includeEnv">;
};

function pick(...xs: Array<string | undefined>): string | undefined {
	for (const x of xs) {
		if (x != null && String(x).trim() !== "") return String(x);
	}
	return undefined;
}

function randomSuffix(): string {
	return Math.random().toString(16).slice(2, 10);
}

export function computeLambdaSourceIdentity(env: Record<string, string | undefined> = process.env): SourceIdentity {
	const explicitApp = pick(env.RATATOUILLE_APP, env.APP, env.SERVICE);
	const explicitWhere = pick(env.RATATOUILLE_WHERE);
	const explicitInstance = pick(env.RATATOUILLE_INSTANCE);

	const functionName = pick(env.AWS_LAMBDA_FUNCTION_NAME, env.FUNCTION_NAME);
	const functionVersion = pick(env.AWS_LAMBDA_FUNCTION_VERSION);
	const region = pick(env.AWS_REGION, env.AWS_DEFAULT_REGION);
	const logGroup = pick(env.AWS_LAMBDA_LOG_GROUP_NAME);
	const logStream = pick(env.AWS_LAMBDA_LOG_STREAM_NAME);
	const executionEnv = pick(env.AWS_EXECUTION_ENV);

	const app = explicitApp || functionName || "lambda";
	const where = explicitWhere || "lambda";

	let instance = explicitInstance;
	if (!instance) {
		const parts: string[] = [];
		if (region) parts.push(region);
		if (functionVersion) parts.push(functionVersion);
		if (logStream) parts.push(logStream);
		if (parts.length === 0) parts.push("lambda", randomSuffix());
		instance = parts.join(":");
	}

	const src: SourceIdentity = { app, where, instance };
	if (functionName) src.lambda_function = functionName;
	if (functionVersion) src.lambda_version = functionVersion;
	if (region) src.aws_region = region;
	if (logGroup) src.lambda_log_group = logGroup;
	if (logStream) src.lambda_log_stream = logStream;
	if (executionEnv) src.aws_execution_env = executionEnv;

	return src;
}

export function createLambdaFactory(opts: LambdaFactoryOptions = {}): LambdaFactory {
	const env = opts.env || process.env;

	const envCfg = ringtailConfigFromEnv(env);
	const url = pick(opts.ringtailUrl, envCfg.url);
	const token = pick(opts.ringtailToken, envCfg.token);

	const enabled = opts.enabled ?? Boolean(url);
	const src = opts.src || computeLambdaSourceIdentity(env);
	const includeEnv = opts.includeEnv ?? true;
	const alsoPrint = opts.alsoPrint ?? false;

	let transport: RingtailTransport | undefined;
	let connectPromise: Promise<void> | undefined;

	const ensureTransport = (): RingtailTransport | undefined => {
		if (!enabled) return undefined;
		if (!url) return undefined;
		if (transport) return transport;

		transport = createRingtailTransport({
			url,
			token,
			src,
			includeEnv,

			batchMs: opts.transport?.batchMs ?? envCfg.batchMs,
			batchBytes: opts.transport?.batchBytes ?? envCfg.batchBytes,
			maxQueueBytes: opts.transport?.maxQueueBytes ?? envCfg.maxQueueBytes,
			maxQueue: opts.transport?.maxQueue ?? envCfg.maxQueue,
			dropPolicy: opts.transport?.dropPolicy ?? envCfg.dropPolicy,
			sampleRate: opts.transport?.sampleRate ?? envCfg.sampleRate,
			keepAlive: opts.transport?.keepAlive,
			headers: opts.transport?.headers,
			defaultTopic: opts.transport?.defaultTopic ?? envCfg.defaultTopic,
		} as any);

		connectPromise = transport
			.connect()
			.catch(() => {
				// swallow; telemetry is best-effort
			});

		return transport;
	};

	const initLogging = async () => {
		const t = ensureTransport();
		if (!t) return;
		if (connectPromise) await connectPromise;
	};

	const topic = (name: string, meta?: Json) => {
		const t = Topic(name, meta ? { meta } : undefined);
		const tr = ensureTransport();
		if (!tr) return t;

		return t.extend(
			(e: any) => {
				try {
					const live = ensureTransport();
					if (!live) return;
					live.send(e);
				} catch {
					// swallow
				}
			},
			alsoPrint,
		);
	};

	return {
		topic,
		initLogging,
		sourceIdentity: () => src,
		transportStatus: () => transport?.status(),
	};
}

export default createLambdaFactory;
