/**
 * Per-file scan watermarks.
 *
 * A transcript is append-only in practice, so the natural resume point is the
 * byte after the last complete newline. `line` continues the absolute line
 * numbering used by evidence citations. `generation` changes when a file is
 * truncated or rewritten, which keeps old index keys from colliding with new
 * content at the same line number.
 */

import type { DiscoveredEvidenceFile } from "./sources.ts";
import type { FileScanSummary } from "./reader.ts";

export interface FileWatermark {
  size: number;
  mtimeMs: number;
  /** Byte offset after the last complete newline. */
  offset: number;
  /** Last absolute line number processed. */
  line: number;
  generation: number;
  sessionId?: string;
  cwd?: string;
  /** Set when the file was deliberately skipped; prevents rescans. */
  filtered?: string;
  unsupported?: string;
}

export interface WatermarkState {
  schema_version: "1";
  started_at: string;
  files: Record<string, FileWatermark>;
}

export interface EvidenceScanPlan {
  file: DiscoveredEvidenceFile;
  mode: "full" | "tail";
  startOffset: number;
  startLine: number;
  generation: number;
  cwd?: string;
}

export interface PlanSkipped {
  unchanged: number;
  filtered: number;
  unsupported: number;
  beforeSince: number;
}

export interface PlanEvidenceScanResult {
  plans: EvidenceScanPlan[];
  skipped: PlanSkipped;
}

export interface PlanEvidenceScanOptions {
  since?: number;
  retryUnsupported?: boolean;
  retryFiltered?: boolean;
}

export function createWatermark(now = new Date()): WatermarkState {
  return {
    schema_version: "1",
    started_at: now.toISOString(),
    files: {},
  };
}

/**
 * Decide what to read for each discovered file.
 *
 * A file with no watermark is read from the beginning (or skipped when it is
 * older than `since`). A file that grew is read from its last complete
 * newline. A file that shrank, was rewritten, or whose previous offset is
 * beyond its current size is read again under a new generation.
 */
export function planEvidenceScan(
  files: readonly DiscoveredEvidenceFile[],
  watermark: WatermarkState | undefined,
  options: PlanEvidenceScanOptions = {},
): PlanEvidenceScanResult {
  const plans: EvidenceScanPlan[] = [];
  const skipped: PlanSkipped = {
    unchanged: 0,
    filtered: 0,
    unsupported: 0,
    beforeSince: 0,
  };

  for (const file of files) {
    const previous = watermark?.files[file.realPath];

    if (!previous) {
      if (
        options.since !== undefined &&
        Number.isFinite(options.since) &&
        file.mtimeMs <= options.since
      ) {
        skipped.beforeSince += 1;
        continue;
      }
      plans.push({
        file,
        mode: "full",
        startOffset: 0,
        startLine: 1,
        generation: 1,
      });
      continue;
    }

    if (previous.unsupported && !options.retryUnsupported) {
      skipped.unsupported += 1;
      continue;
    }
    if (previous.filtered && !options.retryFiltered) {
      skipped.filtered += 1;
      continue;
    }

    const unchanged =
      file.size === previous.size && file.mtimeMs === previous.mtimeMs;
    if (unchanged) {
      skipped.unchanged += 1;
      continue;
    }

    const rewritten =
      file.size < previous.size ||
      file.mtimeMs < previous.mtimeMs ||
      file.size === previous.size ||
      previous.offset > file.size;
    if (rewritten) {
      plans.push({
        file,
        mode: "full",
        startOffset: 0,
        startLine: 1,
        generation: previous.generation + 1,
      });
      continue;
    }

    if (previous.offset < file.size) {
      plans.push({
        file,
        mode: "tail",
        startOffset: previous.offset,
        startLine: previous.line + 1,
        generation: previous.generation,
        cwd: previous.cwd,
      });
      continue;
    }

    skipped.unchanged += 1;
  }

  return { plans, skipped };
}

/**
 * Fold one file's read result into the watermark.
 *
 * A failed read does not advance the watermark: the same bytes are retried on
 * the next run. Filtered and unsupported files do advance to the end of the
 * file, because the decision is about the file as a whole; `--reset-watermark`
 * (or the retry flags in `planEvidenceScan`) can reconsider them.
 */
export function recordFileScan(
  watermark: WatermarkState,
  file: DiscoveredEvidenceFile,
  summary: FileScanSummary,
): WatermarkState {
  if (summary.error) return watermark;

  const previous = watermark.files[file.realPath];
  const skippedWholeFile = summary.filtered || summary.unsupported;
  const entry: FileWatermark = {
    size: summary.size,
    mtimeMs: summary.mtimeMs,
    offset: skippedWholeFile ? summary.size : summary.endOffset,
    line: summary.endLine,
    generation: summary.generation,
    sessionId: summary.sessionId ?? previous?.sessionId,
    cwd: summary.cwd || previous?.cwd,
    filtered: summary.filtered,
    unsupported: summary.unsupported,
  };

  return {
    ...watermark,
    files: {
      ...watermark.files,
      [file.realPath]: entry,
    },
  };
}
