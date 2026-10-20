import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBackendName, backendSelectionNotice } from "../src/storage/backend.ts";
import { openBackend } from "../src/storage/backend.ts";

/**
 * #3931 (step 1): the `storage.backend` selection surface.
 *
 *   env BILI_STORAGE_BACKEND  >  file storage.backend  >  "sqlite"
 *
 * `mysql` is a REGISTERED STUB — the name validates (so configs don't bounce
 * between "unknown backend" and "unimplemented backend" as step 2 lands),
 * but opening it fails with one documented, doctor-readable line. Step 1
 * never loads mysql2; the selection notice keeps the main store on sqlite
 * with a single warn line instead of crashing boots.
 */

test("resolveBackendName: env > file > default sqlite", () => {
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "mysql" }, "sqlite"), "mysql");
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "sqlite" }, undefined), "sqlite");
    assert.equal(resolveBackendName(undefined, "mysql"), "mysql");
    assert.equal(resolveBackendName(undefined, undefined), "sqlite");
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "" }, ""), "sqlite");
    // Unknown names fall back to the default with the notice carrying the
    // complaint (validated at open time where the full error is thrown).
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "oracle" }, undefined), "sqlite");
});

test("backendSelectionNotice: silent on sqlite, explicit everywhere else", () => {
    assert.equal(backendSelectionNotice("sqlite"), undefined);
    const notice = backendSelectionNotice("mysql");
    assert.ok(notice && notice.includes("mysql") && notice.includes("#3388"), "notice names the backend and the tracking issue");
    assert.ok(backendSelectionNotice("oracle")!.includes("oracle"), "unknown names also produce a notice");
});

test("openBackend: sqlite opens; mysql throws the documented step-2 error; unknown lists valid names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-backend-knob-"));
    try {
        const b = openBackend("sqlite", path.join(dir, "index.db"));
        b.close();

        assert.throws(() => openBackend("mysql", path.join(dir, "index.db")), (err: unknown) => {
            const msg = String((err as Error).message);
            return msg.includes("mysql") && msg.includes("#3388") && msg.includes("sqlite");
        }, "mysql stub error names the backend, the issue, and the working default");

        assert.throws(() => openBackend("oracle", path.join(dir, "index.db")), (err: unknown) => {
            const msg = String((err as Error).message);
            return msg.includes("oracle") && msg.includes("sqlite") && msg.includes("mysql");
        }, "unknown backend error lists the valid names");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
