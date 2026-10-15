/**
 * The active Genome of a running session, and what it takes to replace it.
 *
 * A Genome reaches Pi through several different doors (see the projection table
 * in `docs/genome/README.md`), and they do not all reopen. Model, thinking level
 * and the active tool set have setters; policies and tool contracts are re-read
 * on every hook call; settings, keybindings and skills are only re-read by
 * `ctx.reload()`. The system prompt has no setter at all — it is frozen into
 * Pi's resource loader from argv at boot.
 *
 * In the terminal UI a switch therefore restarts the process on the same
 * session file (see `cli/supervisor.ts`), and none of this is needed. Where the
 * process must survive -- RPC and print runs driven by another program -- the
 * switch happens in place, and is three things at once:
 *
 *   1. this holder is repointed, which is why every hook in the extension reads
 *      `session.current()` instead of closing over a Genome,
 *   2. the settings/keybindings projection is rewritten and `ctx.reload()` makes
 *      Pi re-read it -- reload also re-runs the extension factory, which is what
 *      drops the previous Genome's tools and commands (Pi has no
 *      `unregisterTool`), and
 *   3. the instruction delta below is replayed onto every turn's system prompt,
 *      because that is the only door Pi leaves open for prompt text.
 */

/**
 * Prompt text this process put on Pi's argv at startup. Kept verbatim because
 * replacing instructions later means removing exactly these strings again --
 * we are editing our own output, not guessing at Pi's.
 */
export function startupPromptRecord({ systemPrompt, appendPrompt }) {
  return Object.freeze({
    systemPrompt: systemPrompt || undefined,
    appendPrompt: appendPrompt || undefined,
  });
}

/**
 * Rewrite a turn's system prompt so it carries the active Genome's instructions
 * instead of the ones baked in at boot.
 *
 * `base` is Pi's assembled prompt for this turn and `options` is the structured
 * input it was built from, which is what lets us confirm the boot-time text is
 * still the text Pi is using before touching anything.
 *
 * Returns `undefined` when nothing needs to change, so the caller can leave
 * Pi's own prompt in place rather than pinning an identical override.
 */
export function switchedSystemPrompt({ base, options, startup, target }) {
  const sameSystem = (startup.systemPrompt ?? "") === (target.systemPrompt ?? "");
  const sameAppend = (startup.appendPrompt ?? "") === (target.appendPrompt ?? "");
  if (sameSystem && sameAppend) return undefined;

  const caveats = [];
  let prompt = base;
  const trailing = [];

  // Pi reports the loader's own values. If they are not the strings we put on
  // argv, something else owns the prompt -- an explicit --system-prompt, a
  // SYSTEM.md, or another extension -- and overwriting it would be wrong.
  const loaderOwnsOurs =
    (options?.customPrompt ?? undefined) === startup.systemPrompt &&
    joinAppend(options?.appendSystemPrompt) === startup.appendPrompt;

  if (!sameSystem) {
    if (!loaderOwnsOurs || (startup.systemPrompt && !prompt.includes(startup.systemPrompt))) {
      // Leave the base alone and add on top; the existing text is not ours.
      if (target.systemPrompt) trailing.push(target.systemPrompt);
      caveats.push(
        "the base system prompt is owned by something other than the Genome, so the new Genome's `system_prompt` was appended instead of replacing it",
      );
    } else if (startup.systemPrompt && target.systemPrompt) {
      prompt = spliceBlock(prompt, startup.systemPrompt, target.systemPrompt);
    } else if (startup.systemPrompt) {
      // Dropping a base prompt cannot restore Pi's default preamble: that text
      // was never generated for this session.
      prompt = spliceBlock(prompt, startup.systemPrompt, undefined);
      caveats.push(
        "the previous Genome replaced Pi's default system prompt; removing it cannot restore that default, so this session runs without a base prompt until you restart",
      );
    } else {
      // Pi's default preamble is in the prompt and we do not own it, so the new
      // Genome's base prompt can only be layered on top of it.
      trailing.push(target.systemPrompt);
      caveats.push(
        "the new Genome's `system_prompt` was appended rather than replacing Pi's default preamble, which only a restart can do",
      );
    }
  }

  if (!sameAppend) {
    if (startup.appendPrompt && prompt.includes(startup.appendPrompt)) {
      const before = prompt;
      prompt = spliceBlock(prompt, startup.appendPrompt, target.appendPrompt);
      if (countOccurrences(before, startup.appendPrompt) > 1) {
        // Nothing was spliced: the text appears more than once, so there is no
        // single position that is the previous Genome's section.
        caveats.push(
          "the previous Genome's appended instructions appear more than once in the prompt, so they were left in place; restart the session to drop them",
        );
      }
    } else {
      if (startup.appendPrompt) {
        caveats.push(
          "the previous Genome's appended instructions were not found in the prompt and are still in effect",
        );
      }
      if (target.appendPrompt) trailing.push(target.appendPrompt);
    }
  }

  for (const block of trailing) {
    if (block) prompt = `${prompt.trimEnd()}\n\n${block}`;
  }
  return { prompt, caveats };
}

function joinAppend(value) {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : [value];
  const joined = parts.filter(Boolean).join("\n\n");
  return joined || undefined;
}

/**
 * Swap one section of an assembled prompt for another.
 *
 * Pi joins the sections it assembles with a blank line, so removing a section
 * has to take one of its separators with it. Leaving the separator behind is not
 * cosmetic: it means a switched prompt is not byte-identical to the prompt the
 * same Genome would have produced at startup, and the difference is invisible
 * until something diffs the two.
 */
function spliceBlock(text, block, replacement) {
  // A block that occurs more than once has no single position to splice, and
  // replacing the first one would rewrite text the Genome never meant to touch:
  // the caller reports that the switch stayed incomplete instead.
  if (countOccurrences(text, block) !== 1) return text;
  if (replacement) return text.replace(block, () => replacement);
  if (text.includes(`\n\n${block}`)) return text.replace(`\n\n${block}`, "");
  if (text.includes(`${block}\n\n`)) return text.replace(`${block}\n\n`, "");
  return text.replace(block, "");
}

function countOccurrences(text, block) {
  if (!block) return 0;
  let count = 0;
  let index = text.indexOf(block);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(block, index + block.length);
  }
  return count;
}

/**
 * Parts of a Genome that only argv can deliver, and therefore only a restart can
 * change. Reported at switch time rather than silently ignored: a Genome whose
 * extension never loaded is not the Genome the user asked for.
 */
export function unswitchableDifferences(from, to) {
  const differences = [];
  const before = extensionSources(from);
  const after = extensionSources(to);
  if (before.join("\u0000") !== after.join("\u0000")) {
    const added = after.filter((path) => !before.includes(path));
    const kept = before.filter((path) => !after.includes(path));
    const details = [];
    if (kept.length > 0) details.push(`still loaded: ${kept.join(", ")}`);
    if (added.length > 0) details.push(`not loaded: ${added.join(", ")}`);
    differences.push(
      `extensions differ and Pi only reads them from argv (${details.join("; ")})`,
    );
  }
  // Two more argv-only switches. `appearance.theme` is deliberately not here:
  // it is projected into settings.json as well, and reload re-reads that file.
  if (Boolean(from?.resources?.isolate) !== Boolean(to?.resources?.isolate)) {
    differences.push(
      `resource isolation is set by startup CLI flags, so it stays ${
        from?.resources?.isolate ? "on" : "off"
      }`,
    );
  }
  if (Boolean(from?.appearance?.no_themes) !== Boolean(to?.appearance?.no_themes)) {
    differences.push(
      "`appearance.no_themes` is a startup CLI flag and did not change",
    );
  }
  return differences;
}

function extensionSources(genome) {
  return (genome?.extensions ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.source))
    .filter((source) => typeof source === "string" && source.trim() !== "")
    .sort();
}

/**
 * Holds the Genome the session is currently running, plus whatever the next
 * `session_start` still has to tell the user about how it got there.
 *
 * The holder deliberately lives outside the extension factory: `ctx.reload()`
 * re-invokes that factory, and the new invocation has to see the new Genome.
 */
export function createGenomeSession(initial, startup) {
  let active = initial;
  let announcement;
  return {
    current: () => active,
    startup: () => startup,
    /** Repoint the session. The caller is expected to `ctx.reload()` next. */
    switchTo(next, note) {
      // The outgoing Genome travels with the new one: reload carries the active
      // tool set forward, so the runtime needs to know what to release.
      active = { ...next, previousGenome: active.genome };
      announcement = note;
    },
    /** Read once by the post-reload `session_start`, then cleared. */
    takeAnnouncement() {
      const pending = announcement;
      announcement = undefined;
      return pending;
    },
  };
}
