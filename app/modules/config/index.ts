/**
 * The plain-TS reader of `COOKOUT_URL`, `COOKOUT_TOKEN` and `COOKOUT_SESSION`, for the SDK's
 * defaults, the one place that tells from the environment which harness runs
 * the process, and the shape of a connection to a cookout server, which the SDK
 * and the CLI share. In a browser there is no environment, so it reads nothing.
 * Recognise another harness by adding its entry to `harnesses`, and its
 * variables to `harnessVariables`.
 */

type Environment = Readonly<Record<string, string | undefined>>;

interface HarnessMarkers {
  readonly tool: string;
  readonly isRunning: (env: Environment) => boolean;
  readonly sessionVariables: readonly string[];
}

declare const brand: unique symbol;

const NOTHING = {};
const ALLOW_HUMAN = "COOKOUT_ALLOW_HUMAN";

function processEnvironment(): Environment {
  if (typeof process === "undefined") {
    return NOTHING;
  }
  return process.env;
}

function isSet(value: string | undefined): boolean {
  return (value ?? "") !== "";
}

const harnesses: readonly HarnessMarkers[] = [
  {
    isRunning: (env) => env["CLAUDECODE"] === "1",
    sessionVariables: ["CLAUDE_CODE_SESSION_ID"],
    tool: "claude-code",
  },
  {
    isRunning: (env) => isSet(env["CODEX_THREAD_ID"]) || env["CODEX_CI"] === "1",
    sessionVariables: ["CODEX_THREAD_ID"],
    tool: "codex",
  },
  { isRunning: (env) => isSet(env["CURSOR_AGENT"]), sessionVariables: [], tool: "cursor" },
  { isRunning: (env) => env["GEMINI_CLI"] === "1", sessionVariables: [], tool: "gemini-cli" },
  { isRunning: (env) => env["CLINE_ACTIVE"] === "true", sessionVariables: [], tool: "cline" },
  { isRunning: (env) => env["OPENCODE"] === "1", sessionVariables: [], tool: "opencode" },
];

const knownAiHarness = /^(?<tool>claude-code|opencode)(?:_.*)?$/u;
const disallowedInToolName = /[^a-z0-9-]+/gu;
const longerThanToolName = /^(?<kept>[a-z0-9-]{40}).+$/u;
const UNKNOWN_TOOL = "unknown";

function toolNamedBy(value: string): string {
  const sanitised = value
    .replace(knownAiHarness, "$<tool>")
    .replaceAll(disallowedInToolName, "-")
    .replace(/^-+/u, "")
    .replace(longerThanToolName, "$<kept>")
    .replace(/-+$/u, "");
  if (sanitised === "") {
    return UNKNOWN_TOOL;
  }
  return sanitised;
}

function aiHarnessIn(env: Environment): { readonly harness?: string } {
  const value = (env["AI_AGENT"] ?? "").toLowerCase();
  if (value === "") {
    return NOTHING;
  }
  return { harness: toolNamedBy(value) };
}

function urlIn(env: Environment): { readonly url?: string } {
  const url = env["COOKOUT_URL"] ?? "";
  if (url === "") {
    return NOTHING;
  }
  return { url };
}

function isHarnessSessionId(value: string | undefined): value is HarnessSessionId {
  return isSet(value);
}

function sessionIdOf(tool: string, env: Environment): { readonly sessionId?: HarnessSessionId } {
  const values = harnesses
    .filter((markers) => markers.tool === tool)
    .flatMap((markers) => markers.sessionVariables)
    .map((variable) => env[variable]);
  for (const value of values) {
    if (isHarnessSessionId(value)) {
      return { sessionId: value };
    }
  }
  return NOTHING;
}

function firstSet(values: readonly (string | undefined)[]): string {
  return values.find((value) => isSet(value)) ?? "";
}

function tokenIn(env: Environment, inHarness: boolean): string {
  if (inHarness) {
    return firstSet([env["COOKOUT_SESSION"], env["COOKOUT_TOKEN"]]);
  }
  return firstSet([env["COOKOUT_TOKEN"], env["COOKOUT_SESSION"]]);
}

/** Every variable `harnessIn` reads, for a reader of the environment that must name what it reads (the CLI). */
export const harnessVariables: readonly string[] = [
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "CODEX_CI",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "CLINE_ACTIVE",
  "OPENCODE",
  "AI_AGENT",
  "CLAUDE_CODE_SESSION_ID",
  ALLOW_HUMAN,
];

/**
 * The harness `env` shows runs the process, such as `claude-code` (Claude Code sets `CLAUDECODE=1` and
 * `AI_AGENT`), `codex`, `cursor`, `gemini-cli`, `cline` or `opencode`, or, with only `AI_AGENT` set, the tool its value
 * names: `claude-code` for `claude-code_<version>_agent`, `opencode`, or else the value lowercased, with each run of
 * other characters made `-` and cut to 40 characters (`unknown` if nothing is left), unless `COOKOUT_ALLOW_HUMAN=1` says a human's token is meant to be used from it. A guard against
 * accidents, not a security boundary (ADR 0038).
 * @param env Where the markers are read from.
 * @returns The tool's name, if one is found and not overridden.
 */
export function harnessIn(env: Environment): { readonly harness?: string } {
  if (env[ALLOW_HUMAN] === "1") {
    return NOTHING;
  }
  for (const { isRunning, tool } of harnesses) {
    if (isRunning(env)) {
      return { harness: tool };
    }
  }
  return aiHarnessIn(env);
}

/** The ID a harness gives its session, shared by the session's subagents, such as `CLAUDE_CODE_SESSION_ID`. */
export type HarnessSessionId = string & { readonly [brand]: "HarnessSessionId" };

/** A harness session: the tool that runs the process, and its session ID if the tool gives one. */
export interface HarnessSession {
  readonly harness?: string;
  readonly sessionId?: HarnessSessionId;
}

/**
 * The harness session `env` shows runs the process, whatever `COOKOUT_ALLOW_HUMAN` says: the tool `harnessIn`
 * names, and the session ID from the tool's own variable (`CLAUDE_CODE_SESSION_ID` for Claude Code, whose subagents
 * share their parent's), which `cookout join` keys its agent session by (mattpocock/cookout#116).
 * @param env Where the markers are read from.
 * @returns The tool and its session ID, or nothing outside a harness.
 */
export function harnessSessionIn(env: Environment): HarnessSession {
  const { harness = "" } = harnessIn({ ...env, [ALLOW_HUMAN]: "" });
  if (harness === "") {
    return NOTHING;
  }
  return { harness, ...sessionIdOf(harness, env) };
}

/**
 * Where a client connects: the server's base URL, the bearer token if there is one, and the harness running the
 * process if one was found, which the client names in `cookout-harness` on every request.
 */
export interface CookoutConnection {
  readonly url: string;
  readonly token?: string;
  readonly harness?: string;
}

/**
 * `COOKOUT_URL` and the token from `env` (by default the process's), as much of a connection as they give: the token
 * is `COOKOUT_TOKEN`, else the agent session token in `COOKOUT_SESSION`, the other way round inside a harness,
 * whatever `COOKOUT_ALLOW_HUMAN` says (mattpocock/cookout#150). With a token read from `env`, it adds the
 * harness `env` shows runs the process. An empty variable counts as unset.
 * @param env Where the variables are read from.
 * @returns The URL, the token and the harness, each only if set.
 */
export function readCookoutConnection(env: Environment = processEnvironment()): Partial<CookoutConnection> {
  const token = tokenIn(env, isSet(harnessSessionIn(env).harness));
  if (token === "") {
    return urlIn(env);
  }
  return { ...urlIn(env), token, ...harnessIn(env) };
}
