import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, contentHash } from "./json.ts";

export function createArtifact(type, payload, options = {}) {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const lineage = {
    parents: [...(options.parents ?? [])],
    operator: options.operator ?? null,
    operator_version: options.operatorVersion ?? null,
    evidence: [...(options.evidence ?? [])],
  };
  const digest = contentHash({ type, payload, lineage });

  return {
    artifact_id: `${type}:${digest.slice(0, 16)}`,
    artifact_type: type,
    schema_version: options.schemaVersion ?? "1",
    created_at: createdAt,
    content_hash: digest,
    lineage,
    payload,
  };
}

/**
 * The id is `${type}:${digest}` and `type` comes from the caller, so it has to
 * become a name that cannot leave the store: path separators and traversal are
 * replaced rather than escaped, and `get` derives the name the same way `put`
 * does so the two can never disagree.
 */
function fileNameFor(artifactId) {
  return `${String(artifactId)
    .replaceAll(":", "__")
    .replace(/[^A-Za-z0-9._-]+/g, "_")}.json`;
}

function filePathIn(rootDirectory, artifactId) {
  return join(rootDirectory, fileNameFor(artifactId));
}

export class FileArtifactStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  async put(artifact) {
    await mkdir(this.rootDirectory, { recursive: true });
    const target = filePathIn(this.rootDirectory, artifact.artifact_id);
    // Written beside the target and renamed into place: a concurrent reader sees
    // either the previous file or the finished one, never a half-written one.
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, `${canonicalJson(artifact)}\n`, "utf8");
    await rename(temporary, target);
    return artifact;
  }

  async get(artifactId) {
    return JSON.parse(
      await readFile(filePathIn(this.rootDirectory, artifactId), "utf8"),
    );
  }
}
