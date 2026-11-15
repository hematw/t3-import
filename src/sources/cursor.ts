import Database from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalActivity, CanonicalConversation, CanonicalMessage, CanonicalThread,
  CanonicalTurn, DiscoveryOptions, SourceAdapter, SourceSummary,
} from "../core/types.js";
import { canonicalPath, deriveTitle, isObject, isoTimestamp, sha256, stringValue, truncate, type JsonObject } from "../core/util.js";
import { sourceError } from "../core/errors.js";

interface CursorComposer {
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  metadata: JsonObject;
}

function cursorUserRoot(): string {
  // CURSOR_USER_DATA is documented as the User directory itself: it contains
  // globalStorage and workspaceStorage. Do not append another "User" segment.
  if (process.env.CURSOR_USER_DATA?.trim()) return process.env.CURSOR_USER_DATA.trim();
  const home = homedir();
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor", "User");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Cursor", "User");
}

function decode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return undefined;
}

function parseJson(value: unknown): JsonObject | undefined {
  const raw = decode(value);
  if (!raw) return undefined;
  try { const parsed: unknown = JSON.parse(raw); return isObject(parsed) ? parsed : undefined; }
  catch { return undefined; }
}

function fileUriPath(value: unknown): string | undefined {
  if (typeof value === "string") value = { external: value };
  if (!isObject(value)) return undefined;
  const direct = stringValue(value.fsPath) ?? stringValue(value.path);
  if (direct && value.scheme !== "vscode-remote") return direct;
  const external = stringValue(value.external);
  if (!external) return undefined;
  try {
    const url = new URL(external);
    if (url.protocol !== "file:") return undefined;
    let pathname = decodeURIComponent(url.pathname);
    if (process.platform === "win32" && /^\/[a-z]:/iu.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch { return undefined; }
}

function workspaceFromJson(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(value)) return undefined;
    const uri = stringValue(value.folder) ?? stringValue(value.workspace);
    if (!uri) return undefined;
    return fileUriPath({ external: uri });
  } catch { return undefined; }
}

function readTableValue(db: Database.Database, table: string, key: string): unknown {
  try {
    const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as { value?: unknown } | undefined;
    return row?.value;
  } catch { return undefined; }
}

function readComposerRows(db: Database.Database): Map<string, JsonObject> {
  const output = new Map<string, JsonObject>();
  let rows: Array<{ key: string; value: unknown }> = [];
  try {
    rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Array<{ key: string; value: unknown }>;
  } catch { return output; }
  for (const row of rows) {
    const value = parseJson(row.value);
    const id = stringValue(value?.composerId) ?? row.key.slice("composerData:".length);
    if (id && value) output.set(id, value);
  }
  return output;
}

function readWorkspaceIndexes(root: string): Map<string, string> {
  const output = new Map<string, string>();
  const directory = join(root, "workspaceStorage");
  let entries: string[] = [];
  try { entries = readdirSync(directory); } catch { return output; }
  for (const entry of entries) {
    const workspaceDir = join(directory, entry);
    const workspace = workspaceFromJson(join(workspaceDir, "workspace.json"));
    if (!workspace) continue;
    const dbPath = join(workspaceDir, "state.vscdb");
    if (!existsSync(dbPath)) continue;
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const index = parseJson(readTableValue(db, "ItemTable", "composer.composerData"));
      const composers = Array.isArray(index?.allComposers) ? index.allComposers : [];
      for (const item of composers) {
        if (!isObject(item)) continue;
        const id = stringValue(item.composerId);
        if (id && !output.has(id)) output.set(id, workspace);
      }
      for (const key of ["selectedComposerIds", "lastFocusedComposerIds"]) {
        const ids = index?.[key];
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && !output.has(id)) output.set(id, workspace);
      }
    } catch { /* Ignore unrelated or unreadable workspace databases. */ }
    finally { db?.close(); }
  }
  return output;
}

function timestamp(value: unknown, fallback: string): string {
  if (typeof value === "number") return isoTimestamp(value, fallback);
  return isoTimestamp(value, fallback);
}

function messageText(bubble: JsonObject): string {
  const text = stringValue(bubble.text);
  if (text) return text;
  const rich = bubble.richText;
  if (typeof rich === "string") return rich.trim();
  if (Array.isArray(rich)) return rich.flatMap((part) => isObject(part) && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
  return "";
}

function toolActivities(bubble: JsonObject, bubbleId: string, at: string): CanonicalActivity[] {
  const raw = Array.isArray(bubble.toolResults) ? bubble.toolResults : [];
  return raw.flatMap((entry, index) => {
    if (!isObject(entry)) return [];
    const name = stringValue(entry.name) ?? stringValue(entry.toolName) ?? stringValue(entry.type) ?? "Cursor tool";
    const output = stringValue(entry.result) ?? stringValue(entry.output) ?? stringValue(entry.content);
    const input = entry.params ?? entry.input ?? entry.arguments;
    const failed = entry.isError === true || entry.error === true || entry.success === false;
    const itemType = /terminal|command|shell/iu.test(name) ? "command_execution"
      : /edit|write|file/iu.test(name) ? "file_change"
      : /search|web/iu.test(name) ? "web_search" : "dynamic_tool_call";
    return [{
      sourceId: `${bubbleId}:tool:${index}`, timestamp: at,
      tone: failed ? "error" as const : "tool" as const, kind: "tool.completed",
      summary: truncate(name, 120),
      payload: { itemType, status: failed ? "failed" : "completed", title: name, ...(output ? { detail: truncate(output) } : {}), data: { toolCallId: `${bubbleId}:tool:${index}`, item: { name, input, output } } },
    }];
  });
}

function loadComposer(db: Database.Database, composer: CursorComposer, fingerprintSeed: string): CanonicalConversation {
  const metadata = composer.metadata;
  const headers = Array.isArray(metadata.fullConversationHeadersOnly) ? metadata.fullConversationHeadersOnly.filter(isObject) : [];
  const legacyMap = isObject(metadata.conversationMap) ? metadata.conversationMap : {};
  const bubbleRows = new Map<string, JsonObject>();
  try {
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?").all(`bubbleId:${composer.id}:%`) as Array<{ key: string; value: unknown }>;
    for (const row of rows) {
      const value = parseJson(row.value);
      if (value) bubbleRows.set(row.key.slice(`bubbleId:${composer.id}:`.length), value);
    }
  } catch { /* Older databases may only contain conversationMap. */ }

  const turns: CanonicalTurn[] = [];
  let active: CanonicalTurn | undefined;
  for (const [index, header] of headers.entries()) {
    const id = stringValue(header.bubbleId);
    if (!id) continue;
    const bubble = bubbleRows.get(id) ?? (isObject(legacyMap[id]) ? legacyMap[id] as JsonObject : undefined);
    if (!bubble) continue;
    const role = header.type === 1 || bubble.type === 1 ? "user" : header.type === 2 || bubble.type === 2 ? "assistant" : undefined;
    if (!role) continue;
    const at = timestamp(bubble.createdAt, composer.updatedAt);
    const text = messageText(bubble);
    if (role === "user") {
      if (active) {
        active.status = active.assistant.length || active.activities.length ? "completed" : "interrupted";
        active.completedAt = at;
        turns.push(active);
      }
      const user: CanonicalMessage = { sourceId: id, role: "user", text: text || "[Cursor message]", timestamp: at, attachments: [] };
      active = { id, startedAt: at, status: "inProgress", user, assistant: [], activities: [], plans: [] };
    } else if (active) {
      if (text) active.assistant.push({ sourceId: id, role: "assistant", text, timestamp: at, attachments: [] });
      active.activities.push(...toolActivities(bubble, id, at));
    }
  }
  if (active) {
    active.status = active.assistant.length || active.activities.length ? "completed" : "interrupted";
    active.completedAt = active.assistant.at(-1)?.timestamp ?? active.user.timestamp;
    turns.push(active);
  }
  if (!turns.length) throw sourceError(`Cursor conversation ${composer.id} has no readable messages`);
  const modelConfig = isObject(metadata.modelConfig) ? metadata.modelConfig : {};
  const model = stringValue(modelConfig.modelName) ?? "unknown";
  const thread: CanonicalThread = {
    source: "cursor", sourceSessionId: composer.id, sourceKey: `cursor:${composer.id}`,
    currentBranch: true, title: composer.name || deriveTitle(turns[0]!.user.text),
    workspace: composer.workspace, model, createdAt: turns[0]!.startedAt,
    updatedAt: turns.at(-1)!.completedAt ?? composer.updatedAt, turns,
    warnings: ["Imported from Cursor's undocumented local SQLite format. This is a historical transcript only; Cursor sessions cannot be resumed in T3 Code."],
  };
  return {
    summary: { source: "cursor", id: composer.id, title: thread.title, workspace: composer.workspace, path: fingerprintSeed, createdAt: composer.createdAt, updatedAt: composer.updatedAt, status: "complete", branches: 1 },
    threads: [thread],
    fingerprint: sha256(JSON.stringify({ metadata, headers, bubbles: [...bubbleRows.entries()] })),
  };
}

export class CursorSource implements SourceAdapter {
  readonly name = "cursor" as const;

  async discover(options: DiscoveryOptions): Promise<SourceSummary[]> {
    const root = cursorUserRoot();
    const dbPath = join(root, "globalStorage", "state.vscdb");
    if (!existsSync(dbPath)) return [];
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const composers = readComposerRows(db);
      const workspaceById = readWorkspaceIndexes(root);
      const headers = parseJson(readTableValue(db, "ItemTable", "composer.composerHeaders"));
      if (Array.isArray(headers?.allComposers)) {
        for (const entry of headers.allComposers) {
          if (!isObject(entry)) continue;
          const id = stringValue(entry.composerId);
          const workspace = fileUriPath(entry.workspaceIdentifier && isObject(entry.workspaceIdentifier) ? entry.workspaceIdentifier.uri : undefined);
          if (id && workspace) workspaceById.set(id, workspace);
        }
      }
      const summaries: SourceSummary[] = [];
      for (const [id, metadata] of composers) {
        const workspace = workspaceById.get(id);
        if (!workspace) continue; // T3 requires a real project root; omit ephemeral/unresolved chats.
        if (options.workspace && canonicalPath(workspace) !== canonicalPath(options.workspace)) continue;
        const fallback = new Date(0).toISOString();
        const createdAt = timestamp(metadata.createdAt, fallback);
        const updatedAt = timestamp(metadata.lastUpdatedAt ?? metadata.updatedAt ?? metadata.createdAt, createdAt);
        if (options.since && new Date(updatedAt) < options.since) continue;
        summaries.push({
          source: "cursor", id, title: stringValue(metadata.name) ?? `Cursor conversation ${id.slice(0, 8)}`,
          workspace, path: dbPath, createdAt, updatedAt,
          status: "complete", branches: 1,
        });
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      throw sourceError("Unable to inspect Cursor's local chat database. Close Cursor and retry; its SQLite format is undocumented.", error);
    } finally { db?.close(); }
  }

  async load(summary: SourceSummary, _options: DiscoveryOptions): Promise<CanonicalConversation> {
    let db: Database.Database | undefined;
    try {
      db = new Database(summary.path, { readonly: true, fileMustExist: true });
      const metadata = parseJson(readTableValue(db, "cursorDiskKV", `composerData:${summary.id}`));
      if (!metadata) throw sourceError(`Cursor metadata is missing for conversation ${summary.id}`);
      const composer: CursorComposer = {
        id: summary.id, name: stringValue(metadata.name) ?? summary.title,
        workspace: summary.workspace, createdAt: timestamp(metadata.createdAt, summary.createdAt),
        updatedAt: timestamp(metadata.lastUpdatedAt ?? metadata.updatedAt ?? metadata.createdAt, summary.updatedAt),
        metadata,
      };
      return loadComposer(db, composer, summary.path);
    } catch (error) {
      if (error instanceof Error && error.name === "ImporterError") throw error;
      throw sourceError(`Unable to load Cursor conversation ${summary.id}`, error);
    } finally { db?.close(); }
  }
}
