// #3874: an operator who explicitly let dsh compact (allowDshCompaction, #2028)
// has ZERO compaction refusals by construction, so the #2709 refusal-ledger
// witness is structurally blind in that posture — and when a framing-absent
// landing arrives on a session with no active blocks (or no recognizable
// checkpoint bytes in the replay), the framed detector (#2432/#2658) skips too.
// The landing then fell into the generic unannounced-rewrite tier: an alarming
// banner + "cause not confirmed" advice on the user's OWN opt-in. The fix adds
// a third attribution rung: flag on + dsh-bound session => record the quiet
// HANDLED "native-compaction" tier (banner stands down per #2912/#3235), never
// the alarm tier — no checkpoint marker was seen, so nothing is confirmed.
// Fixture shapes mirror the issue report: mature history (>=20 refs), one live
// fold, a decimated framing-absent replay (>=10 msgs, <50% known on both sides).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { createInitialState, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest, type Session } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf, dshOptInCompactionAttributed } from "../src/conflict-watch.ts";

const MODEL_ANTHROPIC = "claude-test";
const MODEL_OPENAI = "deepseek-flash";
const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";
const SEED_COUNT = 22;
const FOLD_END = "m00017";
const RETAINED = [20, 21];
const NEW_TURNS = 8;

_setStoreForTest(new SessionStore({ enabled: false }));

type Rig = {
    url: string;
    pluginToolUrl: string;
    bodies: string[];
    close: () => Promise<void>;
};

function makeSession(id: string, metadata: Record<string, unknown> = {}): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        metadata,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

function seedText(i: number): string {
    // Sized to stay far under the 30k window: an over-window seed triggers preflight compression, whose summary calls hit the stub upstream (2-char answers) and fail-fast 502.
    return `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(30);
}

function seedMessages(): Array<{ role: string; content: string }> {
    return Array.from({ length: SEED_COUNT }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: seedText(i) }));
}

// Framing-absent decimated replay: NEW_TURNS brand-new messages + the retained
// tail (RETAINED) — 10 incoming total, 2 known => 0.2 < 0.5 on the incoming
// side and 2/22 < 0.5 on the prior side, while knownBefore (22) >= the 20-ref
// floor and one deactivated fold block still occupies state.blocks.
function replayMessages(): Array<{ role: string; content: string }> {
    const fresh: Array<{ role: string; content: string }> = Array.from({ length: NEW_TURNS }, (_, j) => ({
        role: j % 2 === 0 ? "user" : "assistant",
        content: `Compacted replay turn ${j} after dsh native compaction. ` + `REPLAY_${j}_filler_`.repeat(40),
    }));
    const kept = RETAINED.map((i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: seedText(i) }));
    return [...fresh, ...kept];
}

async function startProxy(upstreamPort: number, model: string, extra: Record<string, unknown> = {}): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        // preserveRecentTokens: 0 keeps the soft-protected zone at the fixed last-N tail so the m00001..m00017 fold stays outside it regardless of message size.
        compress: { injectTool: true, injectNudge: false, preserveRecentTokens: 0 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
        ...extra,
    } as ProxyOptions);
    await once(proxy, "listening");
    return proxy;
}

async function startAnthropicRig(extra: Record<string, unknown>): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const inputTokens = Math.max(1, Math.round(raw.length / 4));
            const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(
                sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } }) +
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
                sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
                sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
                sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
                sse("message_stop", { type: "message_stop" }),
            );
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, MODEL_ANTHROPIC, extra);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

async function startOpenAiRig(extra: Record<string, unknown>): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            const inputTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: inputTokens, completion_tokens: 2, total_tokens: inputTokens + 2 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, MODEL_OPENAI, extra);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        pluginToolUrl: `http://127.0.0.1:${proxyPort}/__bili/plugin/tool`,
        bodies,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

async function seedAndFold(rig: Rig, conv: string, model: string, headers: Record<string, string>, stream: boolean): Promise<void> {
    const body: Record<string, unknown> = { model, max_tokens: 8192, messages: seedMessages() };
    if (stream) body.stream = true;
    const r1 = await fetch(rig.url, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= SEED_COUNT, "refs assigned to the seeded history");

    const r2 = await fetch(rig.pluginToolUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: FOLD_END, summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

function assertOptInLanding(conv: string): void {
    const s = getSession(conv)!;
    const boundary = s.metadata.compactionBoundary as { pending?: boolean; archivedAt?: number } | undefined;
    assert.ok(boundary, "compaction boundary recorded");
    assert.equal(boundary?.pending, false, "archive consumed within the same request");
    assert.ok(boundary?.archivedAt, "archivedAt stamped");
    const events = conflictEventsOf(s);
    assert.ok(
        events.some((e) => e.kind === "native-compaction" && /allowDshCompaction opt-in active \(#2028\)/.test(e.detail) && /#3874/.test(e.detail)),
        `attributed to the opted-in dsh client compaction (events: ${JSON.stringify(events.map((e) => e.kind))})`,
    );
    assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "no unannounced-rewrite entry beside the handled attribution");
    assert.ok(!events.some((e) => e.kind === "native-compaction-inferred"), "nothing inferred — no checkpoint marker was seen");
    // Exactly the 10 live incoming ids: the retained tail keeps the ref high-water mark, so no ref-floor pin is added.
    assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 10, "refs pruned to exactly the replayed view");
}

test("dshOptInCompactionAttributed: flag on + dsh-bound session only (#3874)", () => {
    assert.equal(dshOptInCompactionAttributed(makeSession("a", { pluginAgent: "dsh" }), true), true);
    assert.equal(dshOptInCompactionAttributed(makeSession("b", { pluginAgent: "dsh" }), false), false);
    assert.equal(dshOptInCompactionAttributed(makeSession("c", { pluginAgent: "pi" }), true), false);
    // sniffed hint (no plugin binding) still resolves the client
    assert.equal(dshOptInCompactionAttributed(makeSession("d", { clientHint: "dsh" }), true), true);
    assert.equal(dshOptInCompactionAttributed(makeSession("e", {}), true), false);
    assert.equal(dshOptInCompactionAttributed(makeSession("f", { pluginAgent: "mcp" }), true), false);
});

test("e2e #3874: framing-absent landing under allowDshCompaction records the handled native-compaction tier on /v1/messages", async () => {
    const rig = await startAnthropicRig({ allowDshCompaction: true });
    const conv = "dshc-3874-ant";
    try {
        await seedAndFold(rig, conv, MODEL_ANTHROPIC, dshHeaders(conv), true);
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true, messages: replayMessages() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        assertOptInLanding(conv);

        // The session keeps working afterwards and does NOT double-record: the
        // next append keeps ~all prior ids (ratio near 1.0), so no second event.
        const s0 = getSession(conv)!;
        const before = Object.keys(s0.state.messageRefs.byRaw).length;
        const r2 = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true, messages: [...replayMessages(), { role: "user", content: "Post-compaction turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s = getSession(conv)!;
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, before + 1, "append-only growth after the rebase");
        assert.equal(conflictEventsOf(s).filter((e) => e.kind === "native-compaction").length, 1, "exactly one attribution event, no double-record");
    } finally {
        await rig.close();
    }
});

test("e2e #3874 negative: default posture (flag off) still records unannounced-rewrite on /v1/messages", async () => {
    const rig = await startAnthropicRig({});
    const conv = "dshc-3874-ant-default";
    try {
        await seedAndFold(rig, conv, MODEL_ANTHROPIC, dshHeaders(conv), true);
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true, messages: replayMessages() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = getSession(conv)!;
        const events = conflictEventsOf(s);
        assert.ok(events.some((e) => e.kind === "unannounced-rewrite"), "pre-existing detection behavior preserved without the opt-in");
        assert.ok(!events.some((e) => e.kind === "native-compaction"), "no handled attribution without the opt-in");
        assert.ok(!events.some((e) => e.kind === "native-compaction-inferred"), "no inference without refusals");
        const boundary = s.metadata.compactionBoundary as { pending?: boolean } | undefined;
        assert.equal(boundary?.pending, false, "archive path unchanged: rebased within the same request");
    } finally {
        await rig.close();
    }
});

test("e2e #3874 negative: opt-in on a non-dsh-bound session still records unannounced-rewrite", async () => {
    const rig = await startAnthropicRig({ allowDshCompaction: true });
    const conv = "dshc-3874-unbound";
    try {
        // Explicit session identity + a non-dsh client UA: without x-acp-session the proxy mints a prefix-affinity id and getSession(conv) misses; the UA keeps conflictClientOf away from "dsh".
        const plainHeaders: Record<string, string> = { "content-type": "application/json", "x-acp-session": conv, "user-agent": "pi/0.1" };
        await seedAndFold(rig, conv, MODEL_ANTHROPIC, plainHeaders, true);
        const s = getSession(conv)!;
        // The /__bili/plugin/tool fold stamps unbound sessions with pluginAgent "mcp" (src/plugin.ts) — assert what matters: not dsh-bound.
        assert.notEqual(s.metadata["pluginAgent"], "dsh", "precondition: session is not dsh-bound");
        assert.equal(dshOptInCompactionAttributed(s, true), false, "rung refuses the unbound session");

        const r = await fetch(rig.url, {
            method: "POST",
            headers: plainHeaders,
            body: JSON.stringify({ model: MODEL_ANTHROPIC, max_tokens: 8192, stream: true, messages: replayMessages() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const events = conflictEventsOf(getSession(conv)!);
        assert.ok(events.some((e) => e.kind === "unannounced-rewrite"), "unbound session keeps the generic tier despite the flag");
        assert.ok(!events.some((e) => e.kind === "native-compaction"), "no dsh attribution for a non-dsh session");
    } finally {
        await rig.close();
    }
});

test("e2e #3874: openai lane mirrors the attribution on /v1/chat/completions", async () => {
    const rig = await startOpenAiRig({ allowDshCompaction: true });
    const conv = "dshc-3874-oai";
    try {
        await seedAndFold(rig, conv, MODEL_OPENAI, dshHeaders(conv), false);
        const r = await fetch(rig.url, {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL_OPENAI, messages: replayMessages() }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        assertOptInLanding(conv);
    } finally {
        await rig.close();
    }
});
