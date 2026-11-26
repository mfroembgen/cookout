import { Array as Arr, Effect, String as Str, pipe } from "effect";
import type { CliResult, CommandLineNeeds } from "../../../testing/server.ts";
import {
  TestCookout,
  commandLineServices,
  freshStateFolder,
  runCookout,
  testCookout,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import { TestClock } from "effect/testing";

interface Step {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

type Env = Readonly<Record<string, string>>;

const EXIT_FAILURE = 1;
const ONE_AT_A_TIME = { concurrency: 1 } as const;
const JOIN = ["join", "--as", "agent"];
const WHOAMI = ["whoami"];
const succeeded = { exitCode: 0, stderr: "" };
const issued = {
  expiresAt: "2026-01-08T00:00:00.000Z",
  issuedAt: "2026-01-01T00:00:00.000Z",
};
const asAgent = { ...succeeded, stdoutJson: { identity: { name: "agent" }, source: "agent session token" } };
const notJoined = {
  exitCode: EXIT_FAILURE,
  stderrJson: { error: { code: "not_joined", message: "join as an agent first: cookout join --as <name>" } },
};
const exportLine = /^export COOKOUT_SESSION=(?<token>\S+)$/u;

function failedWith(code: string): object {
  return { exitCode: EXIT_FAILURE, stderrJson: { error: { code } } };
}

function runAll(steps: readonly Step[]): Effect.Effect<readonly CliResult[], never, CommandLineNeeds> {
  return pipe(steps, Effect.forEach(runCookout, ONE_AT_A_TIME));
}

function claudeCode(session: string, shared: Env): Env {
  return { ...shared, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session };
}

function codex(thread: string, shared: Env): Env {
  return { ...shared, CODEX_THREAD_ID: thread };
}

const harnessSessions = [
  { session: claudeCode, tool: "Claude Code" },
  { session: codex, tool: "Codex" },
] as const;

function exportedToken({ stdout }: CliResult): string {
  return Str.replace(exportLine, "$<token>")(stdout);
}

function withToken(env: Env, token: string): Env {
  return { ...env, COOKOUT_TOKEN: token };
}

function whoamiAfter(
  wait: `${number} ${"millis" | "minutes" | "days"}`,
  env: Env,
): Effect.Effect<unknown, never, CommandLineNeeds> {
  return Effect.andThen(
    TestClock.adjust(wait),
    Effect.map(runCookout({ args: WHOAMI, env }), ({ stdoutJson }) => stdoutJson),
  );
}

it.effect.each(harnessSessions)(
  "a join in one $tool session acts as the agent in that session only, until leave forgets it",
  ({ session }) =>
    Effect.gen(function* joinInOneSession() {
      const cookout = yield* TestCookout;
      const bot = yield* cookout.createIdentity("release-bot");
      const folder = yield* freshStateFolder;
      const shared = { COOKOUT_STATE_DIR: folder, COOKOUT_URL: cookout.url };
      const [first, second] = [session("s1", shared), session("s2", shared)];
      const results = yield* runAll([
        { args: ["join", "--as", "release-bot"], env: { ...first, COOKOUT_TOKEN: bot.token } },
        { args: ["channel", "create", "grill"], env: first },
        { args: WHOAMI, env: second },
        { args: ["channel", "list"], env: second },
        { args: ["leave"], env: first },
        { args: WHOAMI, env: first },
      ]);

      expect(results).toMatchObject([
        { ...succeeded, stdoutJson: { ...issued, created: false, identity: "release-bot", source: "COOKOUT_TOKEN" } },
        { ...succeeded, stdoutJson: { channel: { name: "grill" } } },
        notJoined,
        notJoined,
        { ...succeeded, stdoutJson: { revoked: true } },
        notJoined,
      ]);
    }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("two Codex threads with different IDs each act as the agent their own thread joined as", () =>
  Effect.gen(function* twoCodexThreads() {
    const cookout = yield* TestCookout;
    const [bot, other] = yield* Effect.all(
      [cookout.createIdentity("release-bot"), cookout.createIdentity("other")],
      ONE_AT_A_TIME,
    );
    const shared = { COOKOUT_STATE_DIR: yield* freshStateFolder, COOKOUT_URL: cookout.url };
    const [first, second] = [codex("t1", shared), codex("t2", shared)];
    const results = yield* runAll([
      { args: ["join", "--as", "release-bot"], env: withToken(first, bot.token) },
      { args: ["join", "--as", "other"], env: withToken(second, other.token) },
      { args: WHOAMI, env: first },
      { args: WHOAMI, env: second },
      { args: ["leave"], env: first },
      { args: WHOAMI, env: first },
      { args: WHOAMI, env: second },
    ]);

    expect(results).toMatchObject([
      succeeded,
      succeeded,
      { ...succeeded, stdoutJson: { identity: { name: "release-bot" }, source: "agent session token" } },
      { ...succeeded, stdoutJson: { identity: { name: "other" }, source: "agent session token" } },
      { ...succeeded, stdoutJson: { revoked: true } },
      notJoined,
      { ...succeeded, stdoutJson: { identity: { name: "other" }, source: "agent session token" } },
    ]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("a second join in a joined session is refused naming the agent; --print-env issues one for another", () =>
  Effect.gen(function* secondJoin() {
    const cookout = yield* TestCookout;
    const [bot, other] = yield* Effect.all(
      [cookout.createIdentity("release-bot"), cookout.createIdentity("other")],
      ONE_AT_A_TIME,
    );
    const first = claudeCode("s1", { COOKOUT_STATE_DIR: yield* freshStateFolder, COOKOUT_URL: cookout.url });
    const joinAsBot = { args: ["join", "--as", "release-bot"], env: withToken(first, bot.token) };
    const [, again, printed] = yield* Effect.all(
      [
        runCookout(joinAsBot),
        runCookout(joinAsBot),
        runCookout({ args: ["join", "--as", "other", "--print-env"], env: withToken(first, other.token) }),
      ],
      ONE_AT_A_TIME,
    );
    const fromExport = yield* runCookout({ args: WHOAMI, env: { ...first, COOKOUT_SESSION: exportedToken(printed) } });

    expect(again.stderr).toContain("already joined as release-bot");
    expect(printed.stdout).toMatch(exportLine);
    expect([again, printed, fromExport]).toMatchObject([
      failedWith("already_joined"),
      succeeded,
      {
        ...succeeded,
        stdoutJson: {
          identity: { name: "other" },
          source: "COOKOUT_SESSION",
          summary: `other (COOKOUT_SESSION) at ${cookout.url}`,
        },
      },
    ]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("outside a harness, or in one with no session ID, join is refused, and --print-env prints the export", () =>
  Effect.gen(function* joinOutsideHarness() {
    const cookout = yield* TestCookout;
    const bot = yield* cookout.createIdentity("release-bot");
    const folder = yield* freshStateFolder;
    const env = { COOKOUT_STATE_DIR: folder, COOKOUT_TOKEN: bot.token, COOKOUT_URL: cookout.url };
    const refusals = yield* runAll([
      { args: ["join", "--as", "release-bot"], env },
      { args: ["join", "--as", "release-bot"], env: { ...env, CLAUDECODE: "1" } },
      { args: ["join", "--as", "release-bot"], env: { ...env, CURSOR_AGENT: "1" } },
      { args: ["join", "--as", "release-bot"], env: { ...env, CODEX_CI: "1" } },
    ]);
    const printed = yield* runCookout({ args: ["join", "--as", "release-bot", "--print-env"], env });

    expect(refusals).toMatchObject([
      failedWith("harness_missing"),
      failedWith("harness_session_missing"),
      failedWith("harness_session_missing"),
      failedWith("harness_session_missing"),
    ]);
    expect(
      Arr.join(
        Arr.map(refusals, ({ stderr }) => stderr),
        "\n",
      ),
    ).toContain("cursor gives no session ID");
    expect(printed).toMatchObject(succeeded);
    expect(printed.stdout).toMatch(exportLine);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("whoami says how long ago this harness session joined", () =>
  Effect.gen(function* joinedAgo() {
    const cookout = yield* TestCookout;
    const bot = yield* cookout.createIdentity("release-bot");
    const first = claudeCode("s1", { COOKOUT_STATE_DIR: yield* freshStateFolder, COOKOUT_URL: cookout.url });
    yield* runCookout({ args: ["join", "--as", "release-bot"], env: withToken(first, bot.token) });
    const summaries = yield* Effect.all(
      [whoamiAfter("0 millis", first), whoamiAfter("30 minutes", first), whoamiAfter("3 days", first)],
      ONE_AT_A_TIME,
    );

    expect(summaries).toMatchObject([
      { summary: `release-bot (agent session token, joined just now) at ${cookout.url}` },
      { summary: `release-bot (agent session token, joined 30 min ago) at ${cookout.url}` },
      { summary: `release-bot (agent session token, joined 3 d ago) at ${cookout.url}` },
    ]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("a session's agent session token revoked by another session's join --force is forgotten", () =>
  Effect.gen(function* twoHarnessSessions() {
    const cookout = yield* TestCookout;
    const agent = yield* cookout.createIdentity("agent");
    const folder = yield* freshStateFolder;
    const shared = { COOKOUT_STATE_DIR: folder, COOKOUT_URL: cookout.url };
    const [first, second] = [claudeCode("s1", shared), claudeCode("s2", shared)];
    const results = yield* runAll([
      { args: JOIN, env: withToken(first, agent.token) },
      { args: WHOAMI, env: first },
      { args: JOIN, env: withToken(second, agent.token) },
      { args: [...JOIN, "--force"], env: withToken(second, agent.token) },
      { args: WHOAMI, env: first },
      { args: WHOAMI, env: first },
      { args: ["leave"], env: second },
      { args: ["leave"], env: withToken(second, agent.token) },
      { args: [...JOIN, "--idle-expiry", "30d"], env: withToken(first, agent.token) },
    ]);

    expect(results).toMatchObject([
      { ...succeeded, stdoutJson: issued },
      asAgent,
      failedWith("agent_session_live"),
      succeeded,
      failedWith("agent_session_revoked"),
      notJoined,
      { ...succeeded, stdoutJson: { revoked: true } },
      failedWith("agent_session_required"),
      { ...succeeded, stdoutJson: { expiresAt: "2026-01-31T00:00:00.000Z" } },
    ]);
    expect(
      Arr.join(
        Arr.map(results, (result) => result.stderr),
        "\n",
      ),
    ).toContain("The stored agent session token was deleted; run `cookout join --as agent` to join again.");
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("cookout join without --as, or with a name that breaks the naming rule, is a usage error", () =>
  Effect.gen(function* joinWithoutAs() {
    const env = claudeCode("s1", { COOKOUT_TOKEN: "cookout_x", COOKOUT_URL: "http://127.0.0.1:1" });
    const withoutAs = yield* runCookout({ args: ["join"], env });
    const withoutAsForEnv = yield* runCookout({ args: ["join", "--print-env"], env });
    const badName = yield* runCookout({ args: ["join", "--as", "Not A Name"], env });

    expect([withoutAs, withoutAsForEnv, badName]).toMatchObject([
      failedWith("usage"),
      failedWith("usage"),
      failedWith("usage"),
    ]);
  }).pipe(Effect.provide(commandLineServices)),
);

it.effect("cookout join as a human identity, with or without --force, is refused with identity_kind", () =>
  Effect.gen(function* humanJoin() {
    const cookout = yield* TestCookout;
    const human = yield* cookout.createIdentity("ada", { kind: "human" });
    const folder = yield* freshStateFolder;
    const env = { COOKOUT_STATE_DIR: folder, COOKOUT_TOKEN: human.token, COOKOUT_URL: cookout.url };
    const results = yield* runAll([
      { args: ["join", "--as", "ada", "--print-env"], env },
      { args: ["join", "--as", "ada", "--force", "--print-env"], env },
    ]);
    const refused = {
      exitCode: EXIT_FAILURE,
      stderrJson: { error: { code: "identity_kind", message: "ada is a human identity; only agent identities join." } },
    };

    expect(results).toMatchObject([refused, refused]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);
