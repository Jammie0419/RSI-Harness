/**
 * Append-only JSONL index of normalized evidence events.
 *
 * The index belongs to one base Genome and lives outside `~/.rsih/genomes/`,
 * so it is never mistaken for a Genome. It is the durable record that lets a
 * digest be re-derived without re-reading every transcript, and its length is
 * the cursor the evolution state advances after a successful run.
 *
 * On load, a malformed line (a torn append, for example) is dropped and the
 * valid events are rewritten atomically. A malformed index therefore degrades
 * to "the last write was incomplete", not to "the index is unusable".
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_EVENT_SCHEMA_VERSION,
  emptyEventCounts,
  eventKey,
  isRecord,
  type EvidenceEvent,
  type EvidenceEventKind,
} from "./events.ts";

const EVENT_KINDS = new Set(Object.keys(emptyEventCounts()));

export interface IndexLoadResult {
  events: EvidenceEvent[];
  malformed: number;
  repaired: boolean;
  error?: string;
}

export interface IndexAppendResult {
  appended: number;
  duplicates: number;
  cursor: number;
  repaired: boolean;
}

function isEvent(value: unknown): value is EvidenceEvent {
  if (!isRecord(value)) return false;
  if (value.schema_version !== EVIDENCE_EVENT_SCHEMA_VERSION) return false;
  if (typeof value.session !== "string" || value.session === "") return false;
  if (!Number.isInteger(value.generation) || value.generation < 0) return false;
  if (!Number.isInteger(value.line) || value.line < 0) return false;
  if (!Number.isInteger(value.seq) || value.seq < 0) return false;
  if (typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind)) return false;
  return true;
}

export class EventIndex {
  readonly directory: string;
  readonly path: string;
  private cached?: EvidenceEvent[];
  private keys?: Set<string>;

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, "events.jsonl");
  }

  load(): IndexLoadResult {
    if (this.cached && this.keys) {
      return { events: this.cached, malformed: 0, repaired: false };
    }

    if (!existsSync(this.path)) {
      this.cached = [];
      this.keys = new Set();
      return { events: this.cached, malformed: 0, repaired: false };
    }

    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { events: [], malformed: 0, repaired: false, error: message };
    }

    const events: EvidenceEvent[] = [];
    let malformed = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!isEvent(parsed)) {
          malformed += 1;
          continue;
        }
        events.push(parsed);
      } catch {
        malformed += 1;
      }
    }

    const repaired = malformed > 0;
    if (repaired) this.writeAll(events);
    this.cached = events;
    this.keys = new Set(events.map(eventKey));
    return { events, malformed, repaired };
  }

  append(events: readonly EvidenceEvent[]): IndexAppendResult {
    const loaded = this.load();
    if (loaded.error) {
      throw new Error(`Cannot read evidence index ${this.path}: ${loaded.error}`);
    }
    const keys = this.keys ?? new Set(loaded.events.map(eventKey));
    const fresh: EvidenceEvent[] = [];
    let duplicates = 0;
    for (const event of events) {
      const key = eventKey(event);
      if (keys.has(key)) {
        duplicates += 1;
        continue;
      }
      keys.add(key);
      fresh.push(event);
    }

    if (fresh.length > 0) {
      mkdirSync(this.directory, { recursive: true });
      appendFileSync(
        this.path,
        `${fresh.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
    }

    const merged = [...loaded.events, ...fresh];
    this.cached = merged;
    this.keys = keys;
    return {
      appended: fresh.length,
      duplicates,
      cursor: merged.length,
      repaired: loaded.repaired,
    };
  }

  readSince(cursor: number): EvidenceEvent[] {
    const loaded = this.load();
    if (loaded.error) {
      throw new Error(`Cannot read evidence index ${this.path}: ${loaded.error}`);
    }
    const start = Math.max(0, Math.floor(Number(cursor) || 0));
    return loaded.events.slice(start);
  }

  cursor(): number {
    const loaded = this.load();
    if (loaded.error) {
      throw new Error(`Cannot read evidence index ${this.path}: ${loaded.error}`);
    }
    return loaded.events.length;
  }

  private writeAll(events: readonly EvidenceEvent[]) {
    mkdirSync(this.directory, { recursive: true });
    const text =
      events.length === 0
        ? ""
        : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, text, "utf8");
    try {
      renameSync(temporary, this.path);
    } catch {
      // Windows can refuse a rename over an existing file in some conditions.
      // Falling back to a direct write is still better than leaving the index
      // unreadable; the next successful append rewrites it atomically.
      writeFileSync(this.path, text, "utf8");
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Best effort cleanup; the valid index is already in place.
      }
    }
  }
}
