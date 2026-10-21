/**
 * One incremental evidence scan, end to end.
 *
 * `scanEvidence` is the seam Phase B uses: it takes the files discovered by
 * `sources.ts`, the previous watermark, an optional `since` timestamp and an
 * optional event index, and returns the events plus the new watermark. It does
 * not know whether the caller is doing a first scan after Genome creation or a
 * later scan after a previous evolution; both are just "files, watermark,
 * since".
 *
 * A failed file read never advances that file's watermark and never contributes
 * partial events to the index. The next scan re-reads from the previous
 * complete line, so a transient read error cannot silently lose evidence.
 */

import type { EvidenceEvent } from "./events.ts";
import { EventIndex } from "./index-store.ts";
import {
  readEvidenceFile,
  type FileScanSummary,
} from "./reader.ts";
import type { DiscoveredEvidenceFile } from "./sources.ts";
import {
  createWatermark,
  planEvidenceScan,
  recordFileScan,
  type PlanSkipped,
  type WatermarkState,
} from "./watermark.ts";

export interface EvidenceScanOptions {
  files: readonly DiscoveredEvidenceFile[];
  watermark?: WatermarkState;
  index?: EventIndex;
  /** Only apply to files with no watermark yet. */
  since?: number;
  retryUnsupported?: boolean;
  retryFiltered?: boolean;
}

export interface EvidenceScanCoverage {
  files: number;
  read: number;
  events: number;
  skipped: PlanSkipped;
  filtered: string[];
  unsupported: string[];
  errors: { session: string; error: string }[];
  unknownTypes: Record<string, number>;
  malformed: number;
  calls: number;
  userTurns: number;
  failures: number;
  successes: number;
  unknownOutcomes: number;
}

export interface EvidenceScanResult {
  events: EvidenceEvent[];
  summaries: FileScanSummary[];
  watermark: WatermarkState;
  coverage: EvidenceScanCoverage;
  index?: { appended: number; duplicates: number; cursor: number };
}

function emptyCoverage(): EvidenceScanCoverage {
  return {
    files: 0,
    read: 0,
    events: 0,
    skipped: { unchanged: 0, filtered: 0, unsupported: 0, beforeSince: 0 },
    filtered: [],
    unsupported: [],
    errors: [],
    unknownTypes: {},
    malformed: 0,
    calls: 0,
    userTurns: 0,
    failures: 0,
    successes: 0,
    unknownOutcomes: 0,
  };
}

export async function scanEvidence(
  options: EvidenceScanOptions,
): Promise<EvidenceScanResult> {
  const coverage = emptyCoverage();
  coverage.files = options.files.length;

  let watermark = options.watermark ?? createWatermark();
  const plan = planEvidenceScan(options.files, options.watermark, {
    since: options.since,
    retryUnsupported: options.retryUnsupported,
    retryFiltered: options.retryFiltered,
  });
  coverage.skipped = plan.skipped;

  const events: EvidenceEvent[] = [];
  const summaries: FileScanSummary[] = [];

  for (const item of plan.plans) {
    const result = await readEvidenceFile(
      item.file.realPath,
      item.file.source,
      item,
    );
    summaries.push(result.summary);

    if (result.summary.error) {
      // Do not advance this file and do not index a partial read. The next run
      // starts from the same complete line.
      coverage.errors.push({
        session: item.file.realPath,
        error: result.summary.error,
      });
      continue;
    }

    coverage.read += 1;
    watermark = recordFileScan(watermark, item.file, result.summary);
    events.push(...result.events);

    if (result.summary.filtered) coverage.filtered.push(item.file.realPath);
    if (result.summary.unsupported) coverage.unsupported.push(item.file.realPath);
    coverage.malformed += result.summary.malformed;
    coverage.calls += result.summary.calls;
    coverage.userTurns += result.summary.userTurns;
    coverage.failures += result.summary.failures;
    coverage.successes += result.summary.successes;
    coverage.unknownOutcomes += result.summary.unknownOutcomes;
    for (const [type, count] of Object.entries(result.summary.unknownTypes)) {
      coverage.unknownTypes[type] = (coverage.unknownTypes[type] ?? 0) + count;
    }
  }

  coverage.events = events.length;

  let indexResult;
  if (options.index) {
    indexResult = options.index.append(events);
  }

  return {
    events,
    summaries,
    watermark,
    coverage,
    index: indexResult,
  };
}
