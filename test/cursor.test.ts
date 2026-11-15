import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CursorSource } from "../src/sources/cursor.js";

const previous = process.env.CURSOR_USER_DATA;
afterEach(() => {
  if (previous === undefined) delete process.env.CURSOR_USER_DATA;
  else process.env.CURSOR_USER_DATA = previous;
});

describe("Cursor source adapter", () => {
  it("discovers and loads a local composer transcript read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-import-cursor-"));
    const user = join(root, "User");
    const global = join(user, "globalStorage");
    const workspace = join(user, "workspaceStorage", "workspace-a");
    const project = join(root, "project");
    mkdirSync(global, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(project);
    const id = "cursor-composer-1";
    const db = new Database(join(global, "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(`composerData:${id}`, JSON.stringify({
      composerId: id, name: "Cursor fixture", createdAt: 1760000000000, lastUpdatedAt: 1760000005000,
      fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }, { bubbleId: "a1", type: 2 }],
      modelConfig: { modelName: "claude-4-sonnet" },
    }));
    insert.run(`bubbleId:${id}:u1`, JSON.stringify({ text: "Build a feature", createdAt: 1760000000000, type: 1 }));
    insert.run(`bubbleId:${id}:a1`, JSON.stringify({ text: "I will implement it.", createdAt: 1760000005000, type: 2 }));
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId: id }] }));
    db.close();
    const workspaceDb = new Database(join(workspace, "state.vscdb"));
    workspaceDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);");
    workspaceDb.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("composer.composerData", JSON.stringify({ allComposers: [{ composerId: id }] }));
    workspaceDb.close();
    writeFileSync(join(workspace, "workspace.json"), JSON.stringify({ folder: `file://${project}` }));
    process.env.CURSOR_USER_DATA = user;

    const adapter = new CursorSource();
    const summaries = await adapter.discover({});
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id, source: "cursor", workspace: project });
    const conversation = await adapter.load(summaries[0]!, {});
    expect(conversation.threads[0]).toMatchObject({ source: "cursor", sourceSessionId: id, title: "Cursor fixture", model: "claude-4-sonnet" });
    expect(conversation.threads[0]!.turns[0]).toMatchObject({ status: "completed", user: { text: "Build a feature" } });
    expect(conversation.threads[0]!.turns[0]!.assistant[0]!.text).toBe("I will implement it.");
    expect(conversation.threads[0]!.resumeCursor).toBeUndefined();
  });
});
