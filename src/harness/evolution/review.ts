/**
 * The review step: a deterministic state machine plus two adapters.
 *
 * The state machine owns the rules (Apply validates before it is accepted,
 * Reject skips, Comment asks the model for one revised operation, at most three
 * rounds). The terminal adapter only renders and reads keys, which keeps the
 * rules testable without a real TTY.
 */

import {
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TuiMainScreen,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { EvolutionOperation } from "./patch.ts";

export interface ReviewItem {
  index: number;
  operation: EvolutionOperation;
  wide: boolean;
  summary: string;
  evidence_refs: string[];
  risks: string[];
  before: string;
  after: string;
  validation?: { ok: boolean; error?: string };
}

export type ReviewAction = "apply" | "reject" | "comment" | "cancel";

export interface ReviewProgress {
  position: number;
  total: number;
  /** Total review attempts for display; not a limit by itself. */
  attempt: number;
  apply_failures: number;
  revision_rounds: number;
  apply_limit: number;
  revision_limit: number;
  error?: string;
}

export interface ReviewCompleteSummary {
  applied: number;
  rejected: number;
  revised: number;
  components: string[];
  title: string;
}

export type ReviewFinalAction = "install" | "save" | "cancel";

export interface ReviewUI {
  begin?(title: string, total: number): void;
  stage(
    name: string,
    status: "pending" | "active" | "done" | "failed",
    detail?: string,
  ): void;
  log(line: string): void;
  showItem(item: ReviewItem, progress: ReviewProgress): Promise<ReviewAction>;
  askComment(item: ReviewItem, round: number): Promise<string | undefined>;
  complete(summary: ReviewCompleteSummary): Promise<ReviewFinalAction>;
  done?(message: string): Promise<void>;
  close?(): void;
}

export interface ReviewCallbacks {
  apply(item: ReviewItem): Promise<{ ok: true } | { ok: false; error: string }>;
  revise(
    item: ReviewItem,
    comment: string,
  ): Promise<{ ok: true; item: ReviewItem } | { ok: false; error: string }>;
}

export interface ReviewOptions {
  maxRevisions?: number;
  maxApplyFailures?: number;
  auto?: boolean;
  title?: string;
}

export interface ReviewResult {
  status: "complete" | "cancelled";
  finalAction?: ReviewFinalAction;
  items: ReviewItem[];
  applied: ReviewItem[];
  rejected: ReviewItem[];
  revised: number;
}

const STAGE_ICON = {
  pending: "○",
  active: "●",
  done: "✓",
  failed: "✗",
} as const;

function stageLine(stages: { name: string; status: keyof typeof STAGE_ICON }[]): string {
  return stages.map((stage) => `${STAGE_ICON[stage.status]} ${stage.name}`).join("   ");
}

function padTo(text: string, width: number): string {
  const visible = visibleWidth(text);
  return visible >= width ? truncateToWidth(text, width) : text + " ".repeat(width - visible);
}

function clip(text: string, width: number): string {
  return truncateToWidth(String(text ?? ""), Math.max(1, width));
}

function pageLines(body: string[], width: number): string[] {
  const lines: string[] = [];
  for (const raw of body) {
    if (raw === "") {
      lines.push("");
      continue;
    }
    for (const line of wrapTextWithAnsi(raw, Math.max(10, width))) {
      lines.push(line);
    }
  }
  return lines;
}

/** The review page itself. The TUI owns input; this class owns the pixels. */
class EvolutionScreen implements Component {
  title = "RSIH · Genome evolution";
  stages: { name: string; status: keyof typeof STAGE_ICON }[] = [];
  body: string[] = [];
  footer: string[] = [];
  input?: { prompt: string; value: string };
  private queue: string[] = [];
  private waiter?: (data: string) => void;

  render(width: number): string[] {
    const boxWidth = Math.max(44, Math.min(width, 104));
    const inner = boxWidth - 4;
    const title = ` ${this.title} `;
    const top = `┌${title}${"─".repeat(Math.max(0, boxWidth - visibleWidth(title) - 2))}┐`;
    const bottom = `└${"─".repeat(boxWidth - 2)}┘`;
    const separator = `├${"─".repeat(boxWidth - 2)}┤`;
    const row = (text: string) => `│ ${padTo(text, inner)} │`;

    const lines = [top];
    if (this.stages.length > 0) {
      lines.push(row(stageLine(this.stages)));
      lines.push(separator);
    }
    for (const line of pageLines(this.body, inner)) lines.push(row(line));
    if (this.input) {
      lines.push(row(""));
      lines.push(row(this.input.prompt));
      lines.push(row(`> ${this.input.value}▌`));
    }
    if (this.footer.length > 0) {
      lines.push(separator);
      for (const line of this.footer) {
        lines.push(row(line));
      }
    }
    lines.push(bottom);
    return lines;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(data);
    } else {
      this.queue.push(data);
    }
  }

  waitForKey(): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export interface TerminalReviewUIOptions {
  auto?: boolean;
  /** Milliseconds each auto item stays visible. */
  autoDelayMs?: number;
}

/**
 * Full-screen (main-screen) adapter built on Pi's TUI renderer, so key parsing,
 * raw mode and Windows console handling stay in one place. Auto mode reuses the
 * same pages and only removes the questions.
 */
export class TerminalReviewUI implements ReviewUI {
  readonly auto: boolean;
  private readonly autoDelayMs: number;
  private screen?: EvolutionScreen;
  private tui?: TUI;
  private stages: { name: string; status: keyof typeof STAGE_ICON }[] = [];
  private title = "RSIH · Genome evolution";
  private logs: string[] = [];
  private total = 0;
  private current?: ReviewItem;
  private progress?: ReviewProgress;
  private details = false;
  private closed = false;

  constructor(options: TerminalReviewUIOptions = {}) {
    this.auto = options.auto === true;
    this.autoDelayMs = Math.max(0, options.autoDelayMs ?? 200);
  }

  private ensure(): EvolutionScreen {
    if (this.screen) return this.screen;
    const screen = new EvolutionScreen();
    screen.title = this.title;
    const tui = new TuiMainScreen(new ProcessTerminal(), false);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
    this.screen = screen;
    this.tui = tui;
    return screen;
  }

  private render(): void {
    const screen = this.ensure();
    screen.stages = this.stages;
    if (this.current) {
      screen.body = this.itemBody(this.current);
      screen.footer = this.auto
        ? ["auto mode: applying this change after validation"]
        : ["[a] Apply   [r] Reject   [c] Comment   [d] Details   [q] Cancel"];
      if (this.progress) {
        screen.footer.unshift(
          `Apply failures ${this.progress.apply_failures}/${this.progress.apply_limit}   revisions ${this.progress.revision_rounds}/${this.progress.revision_limit}`,
        );
      }
      if (this.progress?.error) {
        screen.footer.unshift(`! ${this.progress.error}`);
      }
    } else {
      screen.body = [...this.logs];
      screen.footer = [];
    }
    this.tui?.requestRender();
  }

  private itemBody(item: ReviewItem): string[] {
    const lines = [
      `Change ${(this.progress?.position ?? 1)} / ${this.total}   component: ${item.operation.target.component}   op: ${item.operation.op}${item.wide ? "   (wide)" : ""}`,
      "",
      "Before",
      ...this.details || item.before.length <= 400
        ? item.before.split("\n").map((line) => `  ${line}`)
        : [`  ${clip(item.before, 380)}`, "  …"],
      "After",
      ...this.details || item.after.length <= 400
        ? item.after.split("\n").map((line) => `  ${line}`)
        : [`  ${clip(item.after, 380)}`, "  …"],
      "",
      "Evidence",
      ...(item.evidence_refs.length > 0
        ? item.evidence_refs.map((ref) => `  ${ref}`)
        : ["  (none cited)"]),
    ];
    if (item.risks.length > 0) {
      lines.push("", "Risks", ...item.risks.map((risk) => `  ${risk}`));
    }
    lines.push(
      "",
      `Validation  ${
        item.validation?.ok
          ? "✓ pre-check · Apply runs resources + complexity + parent checks"
          : `✗ ${item.validation?.error ?? "not checked"}`
      }`,
    );
    if (this.details) {
      lines.push("", "Operation", ...JSON.stringify(item.operation, null, 2).split("\n"));
    }
    return lines;
  }

  begin(title: string, total: number): void {
    this.title = title;
    this.total = total;
    if (this.screen) this.screen.title = title;
  }

  stage(
    name: string,
    status: "pending" | "active" | "done" | "failed",
    detail?: string,
  ): void {
    const index = this.stages.findIndex((stage) => stage.name === name);
    if (index < 0) this.stages.push({ name, status });
    else this.stages[index].status = status;
    if (detail) this.logs.push(`${name}: ${detail}`);
    if (this.current) this.render();
    else this.render();
  }

  log(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 8) this.logs.shift();
    if (!this.current) this.render();
  }

  async showItem(item: ReviewItem, progress: ReviewProgress): Promise<ReviewAction> {
    this.current = item;
    this.progress = progress;
    this.details = false;
    this.render();
    if (this.auto) {
      if (this.autoDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.autoDelayMs));
      }
      return "apply";
    }
    const screen = this.ensure();
    for (;;) {
      const key = await screen.waitForKey();
      if (matchesKey(key, "a")) return "apply";
      if (matchesKey(key, "r")) return "reject";
      if (matchesKey(key, "c")) return "comment";
      if (matchesKey(key, "d")) {
        this.details = !this.details;
        this.render();
        continue;
      }
      if (matchesKey(key, "q") || matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
        return "cancel";
      }
    }
  }

  async askComment(item: ReviewItem, round: number): Promise<string | undefined> {
    const screen = this.ensure();
    screen.input = {
      prompt: `Comment on change ${this.progress?.position ?? 1} / ${this.total} (round ${round}/3)`,
      value: "",
    };
    this.render();
    for (;;) {
      const key = await screen.waitForKey();
      if (matchesKey(key, "escape")) {
        screen.input = undefined;
        this.render();
        return undefined;
      }
      if (matchesKey(key, "enter")) {
        const value = screen.input.value.trim();
        screen.input = undefined;
        this.render();
        return value || undefined;
      }
      if (matchesKey(key, "backspace")) {
        screen.input.value = screen.input.value.slice(0, -1);
        this.render();
        continue;
      }
      if (key.startsWith("\u001b")) continue;
      const printable = [...key].filter((char) => char >= " " && char !== "\u007f");
      if (printable.length > 0) {
        screen.input.value += printable.join("");
        this.render();
      }
    }
  }

  async complete(summary: ReviewCompleteSummary): Promise<ReviewFinalAction> {
    this.current = undefined;
    this.progress = undefined;
    this.logs = [
      `applied ${summary.applied}   rejected ${summary.rejected}   revised ${summary.revised}`,
      `components: ${summary.components.join(", ") || "(none)"}`,
    ];
    this.render();
    if (this.auto) return "install";
    const screen = this.ensure();
    if (this.screen) {
      this.screen.footer = [
        `[Enter] compile & install (${summary.title})   [s] save proposal   [q] cancel`,
      ];
      this.tui?.requestRender();
    }
    for (;;) {
      const key = await screen.waitForKey();
      if (matchesKey(key, "enter")) return "install";
      if (matchesKey(key, "s")) return "save";
      if (matchesKey(key, "q") || matchesKey(key, "escape") || matchesKey(key, "ctrl+c")) {
        return "cancel";
      }
    }
  }

  async done(message: string): Promise<void> {
    this.current = undefined;
    this.logs = [message];
    this.render();
    if (this.screen) this.screen.footer = this.auto ? [] : ["Press Enter to close"];
    this.tui?.requestRender();
    if (this.auto) {
      if (this.autoDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(this.autoDelayMs, 400)));
      }
      return;
    }
    const screen = this.ensure();
    for (;;) {
      const key = await screen.waitForKey();
      if (matchesKey(key, "enter") || matchesKey(key, "q") || matchesKey(key, "escape")) {
        return;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.tui?.stop();
  }
}

/** Text-only adapter: used for `--auto` when stdout is not a terminal. */
export class PlainReviewUI implements ReviewUI {
  readonly auto: boolean;
  private io: { log(line: string): void };
  private stages: { name: string; status: keyof typeof STAGE_ICON }[] = [];

  constructor(options: { auto?: boolean; io?: { log(line: string): void } } = {}) {
    this.auto = options.auto === true;
    this.io = options.io ?? console;
  }

  stage(name: string, status: "pending" | "active" | "done" | "failed", detail?: string): void {
    const index = this.stages.findIndex((stage) => stage.name === name);
    if (index < 0) this.stages.push({ name, status });
    else this.stages[index].status = status;
    this.io.log(`${STAGE_ICON[status]} ${name}${detail ? `: ${detail}` : ""}`);
  }

  log(line: string): void {
    this.io.log(line);
  }

  async showItem(item: ReviewItem): Promise<ReviewAction> {
    this.io.log(`${item.summary}${item.wide ? " (wide)" : ""}`);
    this.io.log(item.before);
    this.io.log(item.after);
    return this.auto ? "apply" : "reject";
  }

  async askComment(): Promise<string | undefined> {
    return undefined;
  }

  async complete(summary: ReviewCompleteSummary): Promise<ReviewFinalAction> {
    this.io.log(
      `review complete: applied ${summary.applied}, rejected ${summary.rejected}, revised ${summary.revised}`,
    );
    return this.auto ? "install" : "cancel";
  }

  async done(message: string): Promise<void> {
    this.io.log(message);
  }

  close(): void {}
}

/** Pick the adapter for the current run; constructing it starts no terminal. */
export function createReviewUI(options: {
  auto?: boolean;
  isTTY?: boolean;
  io?: { log(line: string): void };
}): ReviewUI {
  return options.isTTY
    ? new TerminalReviewUI({ auto: options.auto })
    : new PlainReviewUI({ auto: options.auto, io: options.io });
}

export async function reviewProposal(
  items: readonly ReviewItem[],
  ui: ReviewUI,
  callbacks: ReviewCallbacks,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const maxRevisions = Math.max(0, Math.floor(options.maxRevisions ?? 3));
  const maxApplyFailures = Math.max(
    1,
    Math.floor(options.maxApplyFailures ?? 3),
  );
  const working = items.map((item) => ({ ...item, evidence_refs: [...item.evidence_refs], risks: [...item.risks] }));
  const applied: ReviewItem[] = [];
  const rejected: ReviewItem[] = [];
  let revised = 0;
  let cancelled = false;

  ui.begin?.(options.title ?? `Review ${working.length} change(s)`, working.length);
  for (const [position, initial] of working.entries()) {
    let item = initial;
    let applyFailures = 0;
    let revisionRounds = 0;
    let error: string | undefined;
    for (;;) {
      const action = await ui.showItem(
        { ...item, validation: { ok: !error, error } },
        {
          position: position + 1,
          total: working.length,
          attempt: applyFailures + revisionRounds,
          apply_failures: applyFailures,
          revision_rounds: revisionRounds,
          apply_limit: maxApplyFailures,
          revision_limit: maxRevisions,
          error,
        },
      );
      if (action === "cancel") {
        cancelled = true;
        break;
      }
      if (action === "reject") {
        rejected.push(item);
        break;
      }
      if (action === "apply") {
        if (applyFailures >= maxApplyFailures) {
          error =
            `No Apply attempts left for this change (limit ${maxApplyFailures}). ` +
            "Revise it or reject it.";
          continue;
        }
        const result = await callbacks.apply({ ...item, validation: { ok: !error, error } });
        if (result.ok) {
          applied.push(item);
          break;
        }
        applyFailures += 1;
        error = result.error;
        if (options.auto) {
          rejected.push(item);
          ui.log(`rejected after validation failure: ${result.error}`);
          break;
        }
        if (applyFailures >= maxApplyFailures) {
          error =
            `${result.error}\nNo Apply attempts left for this change ` +
            `(limit ${maxApplyFailures}). Revise it or reject it.`;
        }
        continue;
      }
      if (action === "comment") {
        if (revisionRounds >= maxRevisions) {
          error = `No revisions left for this change (limit ${maxRevisions}).`;
          continue;
        }
        const comment = await ui.askComment(item, revisionRounds + 1);
        if (!comment) continue;
        const result = await callbacks.revise(item, comment);
        revisionRounds += 1;
        if (!result.ok) {
          error = result.error;
          continue;
        }
        item = { ...result.item, index: item.index };
        working[position] = item;
        revised += 1;
        // A revised operation is a new proposal: give it its own Apply budget,
        // while the Comment rounds stay exhausted independently.
        applyFailures = 0;
        error = undefined;
      }
    }
    if (cancelled) break;
  }

  if (cancelled) {
    return {
      status: "cancelled",
      items: working,
      applied,
      rejected,
      revised,
    };
  }

  const components = [
    ...new Set(applied.map((item) => item.operation.target.component)),
  ].sort();
  const finalAction = await ui.complete({
    applied: applied.length,
    rejected: rejected.length,
    revised,
    components,
    title: components.join(", ") || "no changes",
  });
  return {
    status: "complete",
    finalAction,
    items: working,
    applied,
    rejected,
    revised,
  };
}
