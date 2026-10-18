// #3714: custom-wire endpoints (TRAE llm_utils_chat / Qoder sash agent_chat_generation)
// go DIRECT at the host — never reaching the proxy — so the server-side
// unrecognizedPaths stat stays blind to them. This pins the visibility stopgap: the
// host reports the set via /__bili/plugin/unrouted (handlePluginUnrouted), storage
// keeps it per agent, and an acp_status/compress unknown-conversation 404 NAMES those
// endpoints instead of staying generic.
import assert from "node:assert/strict";
import http from "node:http";
import { beforeEach, describe, it } from "node:test";

import { createCore, defaultConfig } from "acp-kernel";
import { type PluginToolDeps, _resetPluginStateForTest, handlePluginTool, handlePluginUnrouted } from "../src/plugin.ts";
import {
    _resetUnroutedStatusForTest,
    recordUnroutedReport,
    unroutedPathsUnion,
    unroutedStatusWire,
} from "../src/server/unrouted-status.ts";

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

describe("#3714: direct-through-unrecognized-endpoint visibility", () => {
    beforeEach(() => {
        _resetUnroutedStatusForTest();
    });

    describe("storage", () => {
        it("latest report wins per agent; wire + union reflect it", () => {
            recordUnroutedReport("dsh", ["https://a/x", "https://b/y"]);
            recordUnroutedReport("pi", ["https://c/z"]);
            const wire = unroutedStatusWire();
            assert.deepEqual(wire.dsh, ["https://a/x", "https://b/y"]);
            assert.deepEqual(wire.pi, ["https://c/z"]);
            assert.deepEqual(unroutedPathsUnion(), ["https://a/x", "https://b/y", "https://c/z"]);
            recordUnroutedReport("dsh", ["https://only/d"]);
            assert.deepEqual(unroutedStatusWire().dsh, ["https://only/d"]);
            assert.deepEqual(unroutedPathsUnion(), ["https://c/z", "https://only/d"]);
        });

        it("empty until the first report arrives", () => {
            assert.deepEqual(unroutedStatusWire(), {});
            assert.deepEqual(unroutedPathsUnion(), []);
        });
    });

    describe("handlePluginUnrouted (ingest)", () => {
        it("records a valid report", () => {
            const out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: ["https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat"] }), out.res);
            assert.equal(out.status(), 200);
            assert.match(out.body(), /"ok":true/);
            assert.deepEqual(unroutedStatusWire().dsh, ["https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat"]);
        });

        it("rejects missing agent or non-array paths with 400 (nothing recorded)", () => {
            let out = mockRes();
            handlePluginUnrouted(JSON.stringify({ paths: ["x"] }), out.res);
            assert.equal(out.status(), 400);
            out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: "not-an-array" }), out.res);
            assert.equal(out.status(), 400);
            assert.deepEqual(unroutedStatusWire(), {});
        });

        it("rejects invalid JSON with 400", () => {
            const out = mockRes();
            handlePluginUnrouted("{nope", out.res);
            assert.equal(out.status(), 400);
        });

        it("bounds input: drops non-strings/oversize/empty, dedups, caps count", () => {
            const oversize = "https://x/" + "a".repeat(600);
            const many = Array.from({ length: 300 }, (_, i) => `https://x/${i}`);
            const out = mockRes();
            handlePluginUnrouted(JSON.stringify({ agent: "dsh", paths: [oversize, "", "   ", "https://ok/1", "https://ok/1", ...many] }), out.res);
            assert.equal(out.status(), 200);
            const stored = unroutedStatusWire().dsh ?? [];
            assert.ok(!stored.includes(oversize));
            assert.ok(!stored.includes(""));
            assert.equal(stored.filter((p) => p === "https://ok/1").length, 1, "dedup");
            assert.equal(stored.length, 256, "capped");
        });
    });

    describe("acp_status unknown-conversation 404 names the endpoints", () => {
        let deps: PluginToolDeps;
        beforeEach(() => {
            _resetPluginStateForTest();
            deps = { core: createCore(), config: defaultConfig(400_000), log: () => {} };
        });

        async function tool404(conversationId: string): Promise<{ status: number; json: Record<string, unknown> }> {
            const out = mockRes();
            await handlePluginTool(JSON.stringify({ conversationId, tool: "acp_status", args: {} }), out.res, deps);
            return { status: out.status(), json: JSON.parse(out.body()) as Record<string, unknown> };
        }

        it("no reported endpoints → original generic message (unchanged)", async () => {
            const r = await tool404(`ghost-${Math.random().toString(36).slice(2)}`);
            assert.equal(r.status, 404);
            assert.match(String(r.json.error), /unknown plugin conversation \(no model request has arrived/);
            assert.doesNotMatch(String(r.json.error), /going DIRECT \(uncompressed\)/);
        });

        it("reported endpoints → appends the specific DIRECT note naming them", async () => {
            recordUnroutedReport("dsh", [
                "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
                "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
            ]);
            const r = await tool404(`ghost-${Math.random().toString(36).slice(2)}`);
            assert.equal(r.status, 404);
            const err = String(r.json.error);
            assert.match(err, /unknown plugin conversation \(no model request has arrived/);
            assert.match(err, /going DIRECT \(uncompressed\) through unrecognized endpoint/);
            assert.match(err, /llm_utils_chat/);
            assert.match(err, /agent_chat_generation/);
            assert.match(err, /modelEndpointPatterns/);
        });
    });
});
