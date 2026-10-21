/**
 * Model/profile resolution for the evolution command.
 *
 * v1 deliberately requires an explicit provider profile: the evolution module
 * must not reach into the TUI's private built-in profile table. The same
 * `--config` file used by `rsih --config` works here, and tests can use a
 * `kind: "mock"` profile without a network.
 */

import { existsSync } from "node:fs";
import {
  loadEnvFile,
  loadProviderProfiles,
} from "../../model/env.ts";
import { ModelRuntime } from "../../model/model-runtime.ts";

export interface EvolutionModelOptions {
  configPath?: string;
  profileId?: string;
  environment?: NodeJS.ProcessEnv;
  loadEnv?: boolean;
}

export interface EvolutionModel {
  runtime: ModelRuntime;
  profileId: string;
  profiles: Record<string, any>;
}

export function createEvolutionModel(
  options: EvolutionModelOptions = {},
): EvolutionModel {
  if (options.loadEnv !== false && existsSync(".env")) {
    loadEnvFile(".env");
  }

  const configPath = options.configPath?.trim();
  if (!configPath) {
    throw new Error(
      "Evolution requires a provider profile: pass --config <providers.json> [--profile <id>].",
    );
  }

  const profiles = loadProviderProfiles(
    configPath,
    options.environment ?? process.env,
  );
  const ids = Object.keys(profiles);
  if (ids.length === 0) {
    throw new Error(`Provider profile file ${configPath} is empty.`);
  }
  const profileId = options.profileId?.trim() || ids[0];
  if (!profiles[profileId]) {
    throw new Error(
      `Unknown model profile "${profileId}". Available: ${ids.join(", ")}.`,
    );
  }

  return {
    runtime: new ModelRuntime({ profiles }),
    profileId,
    profiles,
  };
}
