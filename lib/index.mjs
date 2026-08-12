import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/shared/envelope.ts
const ENVELOPE_TAG = "dsh-annotation-v1";
const ENVELOPE_OPEN = `<${ENVELOPE_TAG}>`;
const ENVELOPE_CLOSE = `</${ENVELOPE_TAG}>`;
/** The model-visible readable text of one envelope (quote + note + id marker). */
function envelopeReadable(payload, index) {
	return [`> 引用：${payload.quote}`, `批注（第 ${index + 1} 处〔${payload.id}〕）：${payload.note === "" ? "（未填写）" : payload.note}`].join("\n");
}
/** The collapsed-row summary for one batch. */
function batchSummary(count) {
	return `${count} 条批注`;
}
/**
* Parse every envelope in one message text. Strict: unknown versions,
* malformed JSON, out-of-bound fields, or an over-long batch fail the WHOLE
* parse (the caller keeps the message untouched). Never throws.
*/
function parseEnvelopes(text) {
	const tag = new RegExp(`${ENVELOPE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${ENVELOPE_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
	const envelopes = [];
	let match;
	let total = 0;
	while ((match = tag.exec(text)) !== null) {
		const body = match[1] ?? "";
		if (body.length > 65536) return { ok: false };
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			return { ok: false };
		}
		if (!isEnvelope(payload)) return { ok: false };
		if (envelopes.length >= 32) return { ok: false };
		envelopes.push(payload);
		total += payload.quote.length + payload.note.length;
		if (total > 393216) return { ok: false };
	}
	return {
		ok: true,
		envelopes
	};
}
/** Strip every envelope from one message text, leaving the clean question. */
function stripEnvelopes(text) {
	return text.split(ENVELOPE_OPEN).map((segment, index) => {
		if (index === 0) return segment;
		const close = segment.indexOf(ENVELOPE_CLOSE);
		return close < 0 ? segment : segment.slice(close + ENVELOPE_CLOSE.length);
	}).join("");
}
function isEnvelope(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	const keys = Object.keys(candidate);
	if (keys.length !== 4 || !keys.includes("version") || !keys.includes("id") || !keys.includes("quote") || !keys.includes("note")) return false;
	if (candidate.version !== 1) return false;
	if (typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 128) return false;
	if (typeof candidate.quote !== "string" || candidate.quote.length === 0 || candidate.quote.length > 8192) return false;
	if (typeof candidate.note !== "string" || candidate.note.length > 4096) return false;
	return true;
}
//#endregion
//#region src/node/index.ts
/**
* Plugin Node half: registers an `agent/pre-step` listener that splits
* annotation envelopes out of claimed user messages into native context +
* clean question. Pure plugin code — no DSH modification. Ordinary messages
* (no envelopes) pass through untouched; a malformed envelope keeps the whole
* message as-is; the splitter never throws.
*/
const PLUGIN_NAME = "dsh-annotation";
/**
* Split envelopes out of one claimed message batch. Returns null when no
* user message carries a valid envelope (caller keeps the batch untouched) —
* including the case where ANY envelope is malformed (whole message kept).
*/
function splitAnnotationMessages(messages) {
	let changed = false;
	const out = [];
	for (const message of messages) {
		if (message.source.kind !== "user") {
			out.push(message);
			continue;
		}
		const text = message.content.map((block) => block.type === "text" ? block.text : "").join("");
		if (!text.includes("<dsh-annotation-v1>")) {
			out.push(message);
			continue;
		}
		const parsed = parseEnvelopes(text);
		if (!parsed.ok || parsed.envelopes.length === 0) return null;
		const clean = stripEnvelopes(text);
		changed = true;
		out.push(buildContextMessage(message.id, parsed.envelopes));
		if (clean.trim() !== "") out.push({
			...message,
			content: [{
				type: "text",
				text: clean
			}]
		});
	}
	return changed ? out : null;
}
/** The native collapsed context row (plugin source, notice form). */
function buildContextMessage(originalId, envelopes) {
	return createUserMessage({
		content: [{
			type: "text",
			text: envelopes.map((envelope, index) => envelopeReadable(envelope, index)).join("\n\n")
		}],
		source: {
			kind: "plugin",
			plugin: PLUGIN_NAME,
			form: "notice",
			summary: batchSummary(envelopes.length)
		}
	});
}
/** The plugin body: one `agent/pre-step` listener, ordinary path is a no-op. */
var node_default = {
	name: "dsh-annotation",
	apply(ctx) {
		ctx.on("agent/pre-step", (payload, next) => {
			const runNext = next;
			return Promise.resolve(typeof runNext === "function" ? runNext() : void 0).then((decision) => {
				if (decision === null || typeof decision !== "object") return decision;
				const candidate = decision;
				if (candidate.kind !== "enter" || !Array.isArray(candidate.messages)) return decision;
				const split = splitAnnotationMessages(candidate.messages);
				if (split === null) return decision;
				return {
					kind: "enter",
					messages: split
				};
			});
		});
	}
};
//#endregion
export { PLUGIN_NAME, buildContextMessage, node_default as default, splitAnnotationMessages };
