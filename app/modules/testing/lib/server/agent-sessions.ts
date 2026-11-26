import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect";
import type { TestCookoutService, TestIdentity } from "./cookout.ts";
import type { CookoutClient } from "../../../sdk/index.ts";
import type { Scope } from "effect";

interface TwoSessions {
  readonly agent: TestIdentity;
  readonly first: CookoutClient;
  readonly second: CookoutClient;
}

interface AgentSessionStateText {
  readonly folder: string;
  readonly text: string;
}

interface StoredAgentSessionToken {
  readonly folder: string;
  readonly token: string;
}

type Files = FileSystem.FileSystem | Path.Path;

const ONE_AT_A_TIME = { concurrency: 1 } as const;
const storedToken = /"agentSessionToken": "[^"]+"/u;

function twoSessions(cookout: TestCookoutService): Effect.Effect<TwoSessions> {
  return Effect.gen(function* identityWithTwoSessions() {
    const agent = yield* cookout.createIdentity("auth-griller", { owner: "matt" });
    yield* Effect.promise(() => agent.client.createChannel({ name: "grill" }));
    return { agent, first: cookout.clientFor(agent.token), second: cookout.clientFor(agent.token) };
  });
}

const freshStateFolder: Effect.Effect<string, never, FileSystem.FileSystem | Scope.Scope> = Effect.gen(
  function* makeStateFolder() {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "cookout-state-" });
  },
).pipe(Effect.orDie);

function agentSessionStateFiles(stateFolder: string): Effect.Effect<readonly string[], never, Files> {
  return Effect.gen(function* listAgentSessionStates() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = path.join(stateFolder, "agent-sessions");
    const names = yield* fs.readDirectory(folder);
    return Arr.map(names, (name) => path.join(folder, name));
  }).pipe(Effect.orDie);
}

function writeAgentSessionStates({ folder, text }: AgentSessionStateText): Effect.Effect<void, never, Files> {
  return Effect.gen(function* overwriteAgentSessionStates() {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* agentSessionStateFiles(folder);
    yield* Effect.forEach(files, (file) => fs.writeFileString(file, text), ONE_AT_A_TIME);
  }).pipe(Effect.orDie);
}

function storedAgentSessionStates(folder: string): Effect.Effect<readonly string[], never, Files> {
  return Effect.gen(function* readAgentSessionStates() {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* agentSessionStateFiles(folder);
    return yield* Effect.forEach(files, (file) => fs.readFileString(file), ONE_AT_A_TIME);
  }).pipe(Effect.orDie);
}

function storeAgentSessionToken({ folder, token }: StoredAgentSessionToken): Effect.Effect<void, never, Files> {
  return Effect.gen(function* replaceStoredToken() {
    const [text = ""] = yield* storedAgentSessionStates(folder);
    const replaced = Str.replace(storedToken, `"agentSessionToken": "${token}"`)(text);
    yield* writeAgentSessionStates({ folder, text: replaced });
  });
}

export {
  type TwoSessions,
  freshStateFolder,
  agentSessionStateFiles,
  storeAgentSessionToken,
  storedAgentSessionStates,
  twoSessions,
  writeAgentSessionStates,
};
