import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewUI,
  PlainReviewUI,
  reviewProposal,
  TerminalReviewUI,
  type ReviewAction,
  type ReviewCompleteSummary,
  type ReviewFinalAction,
  type ReviewItem,
  type ReviewProgress,
  type ReviewUI,
} from "../src/harness/evolution/review.ts";

class FakeUI implements ReviewUI {
  actions: ReviewAction[];
  comments: (string | undefined)[];
  shown: { item: ReviewItem; progress: ReviewProgress }[] = [];
  logs: string[] = [];
  finalAction: ReviewFinalAction = "install";
  doneMessage?: string;

  constructor(actions: (ReviewAction | "details")[], comments: (string | undefined)[] = []) {
    this.actions = actions.filter((action) => action !== "details") as ReviewAction[];
    this.comments = comments;
  }

  begin(): void {}

  stage(): void {}

  log(line: string): void {
    this.logs.push(line);
  }

  async showItem(item: ReviewItem, progress: ReviewProgress): Promise<ReviewAction> {
    this.shown.push({ item, progress });
    return this.actions.shift() ?? "reject";
  }

  async askComment(): Promise<string | undefined> {
    return this.comments.shift();
  }

  async complete(summary: ReviewCompleteSummary): Promise<ReviewFinalAction> {
    this.logs.push(`complete:${summary.applied}`);
    return this.finalAction;
  }

  async done(message: string): Promise<void> {
    this.doneMessage = message;
  }
}

function item(index: number, find = "old"): ReviewItem {
  return {
    index,
    operation: {
      op: "text.patch",
      target: { component: "instructions", field: "append_system_prompt" },
      find,
      replace: `${find}-new`,
    },
    wide: false,
    summary: `text.patch change ${index}`,
    evidence_refs: ["signature:bash|pytest|tests/*"],
    risks: [],
    before: `- ${find}`,
    after: `+ ${find}-new`,
  };
}

test("apply and reject are independent; only applied items reach the working set", async () => {
  const ui = new FakeUI(["apply", "reject", "apply"]);
  const applied: number[] = [];
  const result = await reviewProposal(
    [item(0), item(1), item(2)],
    ui,
    {
      async apply(candidate) {
        applied.push(candidate.index);
        return { ok: true };
      },
      async revise() {
        throw new Error("not used");
      },
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.finalAction, "install");
  assert.deepEqual(applied, [0, 2]);
  assert.deepEqual(result.applied.map((entry) => entry.index), [0, 2]);
  assert.deepEqual(result.rejected.map((entry) => entry.index), [1]);
  assert.equal(result.revised, 0);
});

test("a failed Apply keeps the item open and shows the error", async () => {
  const ui = new FakeUI(["apply", "apply"]);
  let attempts = 0;
  const result = await reviewProposal([item(0)], ui, {
    async apply() {
      attempts += 1;
      return attempts === 1
        ? { ok: false, error: "resource missing" }
        : { ok: true };
    },
    async revise() {
      throw new Error("not used");
    },
  });

  assert.equal(attempts, 2);
  assert.equal(ui.shown.length, 2);
  assert.equal(ui.shown[0].progress.error, undefined);
  assert.equal(ui.shown[1].progress.error, "resource missing");
  assert.equal(result.applied.length, 1);
});

test("Comment revises one item and the revised operation is applied", async () => {
  const ui = new FakeUI(["comment", "apply"], ["use a smaller change"]);
  let revisedOperation: unknown;
  const result = await reviewProposal([item(0)], ui, {
    async apply(candidate) {
      revisedOperation = candidate.operation;
      return { ok: true };
    },
    async revise(candidate, comment) {
      assert.equal(comment, "use a smaller change");
      return {
        ok: true,
        item: {
          ...candidate,
          operation: {
            op: "text.patch",
            target: { component: "instructions", field: "append_system_prompt" },
            find: "small",
            replace: "smaller",
          },
          before: "- small",
          after: "+ smaller",
        },
      };
    },
  });

  assert.equal(result.revised, 1);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(revisedOperation, {
    op: "text.patch",
    target: { component: "instructions", field: "append_system_prompt" },
    find: "small",
    replace: "smaller",
  });
});

test("the revision limit is enforced per item", async () => {
  const ui = new FakeUI(
    ["comment", "comment", "comment", "comment", "reject"],
    ["one", "two", "three", "four"],
  );
  let revisions = 0;
  const result = await reviewProposal(
    [item(0)],
    ui,
    {
      async apply() {
        return { ok: true };
      },
      async revise(candidate) {
        revisions += 1;
        return { ok: true, item: candidate };
      },
    },
    { maxRevisions: 3 },
  );

  assert.equal(revisions, 3);
  assert.equal(result.rejected.length, 1);
  assert.match(ui.shown.at(-1)!.progress.error!, /No revisions left/);
  assert.equal(ui.shown.at(-1)!.progress.revision_rounds, 3);
});

test("Apply failures do not consume Comment revision rounds", async () => {
  const ui = new FakeUI(["apply", "apply", "comment", "apply"], ["fixed"]);
  let applyCalls = 0;
  let revisions = 0;
  const result = await reviewProposal([item(0)], ui, {
    async apply() {
      applyCalls += 1;
      return applyCalls < 3
        ? { ok: false, error: `failure ${applyCalls}` }
        : { ok: true };
    },
    async revise(candidate) {
      revisions += 1;
      return { ok: true, item: candidate };
    },
  });

  assert.equal(applyCalls, 3);
  assert.equal(revisions, 1);
  assert.equal(result.revised, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(ui.shown[2].progress.revision_rounds, 0);
  assert.equal(ui.shown[2].progress.apply_failures, 2);
});

test("three Apply failures stop further Apply attempts for that item", async () => {
  const ui = new FakeUI(["apply", "apply", "apply", "apply", "reject"]);
  let applyCalls = 0;
  const result = await reviewProposal([item(0)], ui, {
    async apply() {
      applyCalls += 1;
      return { ok: false, error: "still invalid" };
    },
    async revise() {
      throw new Error("not used");
    },
  });

  assert.equal(applyCalls, 3, "the fourth Apply must be blocked locally");
  assert.equal(result.rejected.length, 1);
  assert.equal(ui.shown.at(-1)!.progress.apply_failures, 3);
  assert.match(ui.shown.at(-1)!.progress.error!, /No Apply attempts left/);
});

test("a successful revision gets a fresh Apply budget", async () => {
  const ui = new FakeUI(["apply", "apply", "apply", "comment", "apply"], ["revise"]);
  let applyCalls = 0;
  const result = await reviewProposal([item(0)], ui, {
    async apply() {
      applyCalls += 1;
      return applyCalls <= 3
        ? { ok: false, error: "invalid before revision" }
        : { ok: true };
    },
    async revise(candidate) {
      return {
        ok: true,
        item: { ...candidate, operation: { ...candidate.operation, replace: "revised" } },
      };
    },
  });

  assert.equal(applyCalls, 4);
  assert.equal(result.revised, 1);
  assert.equal(result.applied.length, 1);
  assert.equal(ui.shown.at(-1)!.progress.apply_failures, 0);
  assert.equal(ui.shown.at(-1)!.progress.revision_rounds, 1);
});

test("auto mode rejects an item whose validation fails instead of looping", async () => {
  const ui = new FakeUI(["apply"]);
  const result = await reviewProposal(
    [item(0)],
    ui,
    {
      async apply() {
        return { ok: false, error: "complexity exceeded" };
      },
      async revise() {
        throw new Error("not used");
      },
    },
    { auto: true },
  );

  assert.equal(result.rejected.length, 1);
  assert.equal(result.applied.length, 0);
  assert.ok(ui.logs.some((line) => line.includes("complexity exceeded")));
});

test("cancelling stops before the working set is finalized", async () => {
  const ui = new FakeUI(["apply", "cancel"]);
  const result = await reviewProposal([item(0), item(1)], ui, {
    async apply() {
      return { ok: true };
    },
    async revise() {
      throw new Error("not used");
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.finalAction, undefined);
});

test("TTY runs use the terminal adapter, non-TTY runs use plain output", () => {
  assert.ok(createReviewUI({ isTTY: true }) instanceof TerminalReviewUI);
  assert.ok(createReviewUI({ isTTY: false }) instanceof PlainReviewUI);
  assert.equal((createReviewUI({ isTTY: true, auto: true }) as TerminalReviewUI).auto, true);
});
