import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One `KEY=value` assignment, read the way dotenv files mean it: a leading
 * `export` is shell spelling of the same thing, a value ends at its closing
 * quote or at a whitespace-preceded comment, and anything that is not a plain
 * identifier before the `=` is not an assignment.
 */
function parseEnvLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  const assignment = line.startsWith("export ")
    ? line.slice("export ".length).trimStart()
    : line;
  const separator = assignment.indexOf("=");
  if (separator < 1) return undefined;
  const key = assignment.slice(0, separator).trim();
  if (!KEY_PATTERN.test(key)) return undefined;

  let value = assignment.slice(separator + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const closing = value.indexOf(value[0], 1);
    value = closing === -1 ? value.slice(1) : value.slice(1, closing);
  } else {
    const comment = value.search(/(^|\s)#/);
    if (comment !== -1) value = value.slice(0, comment).trimEnd();
  }
  return { key, value };
}

export function loadEnvFile(path = ".env", options = {}) {
  const absolutePath = resolve(path);
  const text = readFileSync(absolutePath, "utf8");
  const loaded = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const entry = parseEnvLine(rawLine);
    if (!entry) continue;
    if (!options.override && process.env[entry.key] !== undefined) continue;
    process.env[entry.key] = entry.value;
    loaded.push(entry.key);
  }

  return loaded;
}

function resolveProfileValue(profile, field, envField, environment) {
  if (profile[field] !== undefined) return profile[field];
  const variable = profile[envField];
  if (!variable) return undefined;
  return environment[variable];
}

export function resolveProviderProfile(id, profile, environment = process.env) {
  const resolved = {
    ...profile,
    id,
    model: resolveProfileValue(profile, "model", "model_env", environment),
    base_url: resolveProfileValue(
      profile,
      "base_url",
      "base_url_env",
      environment,
    ),
    api_key: resolveProfileValue(
      profile,
      "api_key",
      "api_key_env",
      environment,
    ),
  };

  delete resolved.model_env;
  delete resolved.base_url_env;
  delete resolved.api_key_env;
  return resolved;
}

export function loadProviderProfiles(path, environment = process.env) {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  return Object.fromEntries(
    Object.entries(raw).map(([id, profile]) => [
      id,
      resolveProviderProfile(id, profile, environment),
    ]),
  );
}
