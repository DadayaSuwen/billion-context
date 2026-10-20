import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
// The contract suite deliberately imports NOTHING from store.ts: every
// assertion goes through the StorageBackend interface only. When the mysql
// backend lands (#3388 step 2) this same file runs against it unchanged.
import { openBackend, listBackendNames } from "../src/storage/backend.ts";

/**
 * #3931 (step 1 of the #3388 pluggable-storage plan): the operation-level
 * backend contract. This suite is the seam proof — the registry resolves a
 * backend by name and the whole storage surface (ingest, reads, session_ext,
 * watermark, reap journal, archive/restore, gc, conversation lookup, delete
 * with refcount release, close) is exercised through the interface.
 *
 * Against sqlite today the results must equal what the UnifiedStore path
 * produces (pinned elsewhere by the corpus/golden suites); the point here is
 * that the CONTRACT carries the operations and their semantics, so a second
 * implementation has a fixed target to hit.
 */

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai", label: `label-${id}` },
    stats: {},
    metadata: { },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-backend-contract-"));
}

test("registry: sqlite resolves through the registry; names are advertised", async () => {
    const names = listBackendNames();
    assert.ok(names.includes("sqlite"), "sqlite is a registered backend");
    assert.ok(names.includes("mysql"), "mysql is registered as a step-2 stub so config validation recognizes it");
    const dir = scratch();
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        await backend.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: ingest → reads round-trip through the interface", async () => {
    const dir = scratch();
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const msgs = [mkMsg("m1", "hello " + "x".repeat(200)), mkMsg("m2", "world " + "y".repeat(200))];
            await backend.ingestSession(planIngest(mkSession("sess-contract", msgs)));

            const row = await backend.getSessionRow("sess-contract");
            assert.ok(row, "session row readable via the interface");
            assert.equal(row!.sessionId, "sess-contract");
            assert.equal(row!.label, "label-sess-contract");

            const rows = await backend.getMessages("sess-contract");
            assert.equal(rows.length, 2, "both messages landed");
            const parsed = JSON.parse(rows[1]!.content) as { id?: string };
            assert.equal(parsed.id, "m2", "message content is the verbatim core JSON");
            assert.ok(typeof rows[1]!.contentHash === "string" && rows[1]!.contentHash.length > 0, "content hashes ride the rows");

            const counters = await backend.sessionCounters("sess-contract");
            assert.ok(counters, "session counters readable");

            const ids = await backend.listSessionIds();
            assert.ok(ids.includes("sess-contract"), "session enumerated");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: session_ext + watermark + tailSeqs", async () => {
    const dir = scratch();
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-ext", [mkMsg("m1", "payload".repeat(60))])));
            await backend.setSessionExt("sess-ext", "inc:canonical-ptrs", [0, 1]);
            assert.deepEqual(await backend.getSessionExt("sess-ext", "inc:canonical-ptrs"), [0, 1]);
            const listed = await backend.listSessionExt("sess-ext");
            assert.equal(listed.filter((e) => e.key === "inc:canonical-ptrs").length, 1);
            assert.equal(await backend.deleteSessionExt("sess-ext", "inc:canonical-ptrs"), 1);
            // session_ext reads return undefined when the key is absent
            // (verbatim store semantics — the contract keeps them).
            assert.equal(await backend.getSessionExt("sess-ext", "inc:canonical-ptrs"), undefined);

            const wm = await backend.ingestWatermark("sess-ext");
            assert.ok(wm && typeof wm.seq === "number", "watermark readable");
            const tails = await backend.tailSeqs("sess-ext");
            assert.ok(Array.isArray(tails), "tailSeqs readable");
            await backend.clearIngestWatermark("sess-ext");
            assert.equal(await backend.ingestWatermark("sess-ext"), null, "clearIngestWatermark clears it");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: reap journal orphans through the interface (#3841 semantics)", async () => {
    const dir = scratch();
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-reap", [mkMsg("m1", "keep".repeat(80))])));
            const orphans = new Map([["b2", { one: null, full: { text: "orphaned summary", count: 0 } }]]);
            await backend.reapBlocks("sess-reap", new Set(["b2"]), orphans);
            // Idempotent: re-running the journal with the same shape is a no-op.
            await backend.reapBlocks("sess-reap", new Set(["b2"]), new Map());
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: archive → restore round-trip + gc counters", async () => {
    const dir = scratch();
    const archiveDir = path.join(dir, "archive");
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        try {
            await backend.ingestSession(planIngest(mkSession("sess-gc", [mkMsg("m1", "gc target".repeat(120))])));
            const archived = await backend.archiveSession("sess-gc", { archiveDir });
            assert.ok(archived.ok && archived.exportPath, "archive ok");
            assert.ok(fs.existsSync(archived.exportPath!), "export landed on disk");
            const row = await backend.getSessionRow("sess-gc");
            assert.equal(row!.status, "archived", "tombstone keeps the row");
            const restored = await backend.restoreArchived("sess-gc", { archiveDir });
            assert.ok(restored.ok, `restore ok (${restored.reason ?? ""})`);
            const back = await backend.getSessionRow("sess-gc");
            assert.equal(back!.status, "active", "restore reactivates");
            const gc = await backend.gc({ archiveAfterDays: 365, archiveDir, now: 9_000_000_000_000 });
            assert.ok(gc.archived >= 0 && gc.contentRowsDeleted >= 0, "gc returns counters");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("contract: conversation lookup + delete releases content refs", async () => {
    const dir = scratch();
    try {
        const backend = openBackend("sqlite", path.join(dir, "index.db"));
        try {
            const shared = mkMsg("m-shared", "shared body ".repeat(50));
            await backend.ingestSession(planIngest(mkSession("sess-del-a", [shared])));
            await backend.ingestSession(planIngest(mkSession("sess-del-b", [shared])));
            const before = await backend.contentRefCountOfBody("shared body ");
            assert.ok(before >= 2, "shared content is refcounted across sessions");
            await backend.deleteSession("sess-del-a");
            const after = await backend.contentRefCountOfBody("shared body ");
            assert.equal(after, before - 1, "delete releases exactly this session's refs");
            assert.equal(await backend.getSessionRow("sess-del-a"), null, "row gone");
        } finally {
            await backend.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
