import type { CommandLineNeeds, TestCookoutService } from "../../../testing/server.ts";
import { Effect, FileSystem, Path, Ref, Schema } from "effect";
import {
  TestCookout,
  answer,
  commandLineServices,
  forwardingProxy,
  freshStateFolder,
  runCookout,
  serverAnswering,
  storeAgentSessionToken,
  storedAgentSessionStates,
  testCookout,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import type { Scope } from "effect";
import { agentSessionPath } from "../../../agent-sessions/index.ts";

interface Joined {
  readonly cookout: TestCookoutService;
  readonly env: Env;
  readonly folder: string;
  readonly token: string;
}

interface Refusal {
  readonly refusedAs: string;
  readonly stale: (joined: Joined) => Effect.Effect<void, never, CommandLineNeeds>;
}

interface Credentials {
  readonly defaultBoard: string;
  readonly file: string;
}

interface LoggedIn {
  readonly cookout: TestCookoutService;
  readonly env: Env;
  readonly file: string;
}

type Env = Readonly<Record<string, string>>;

const EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;
const JOIN = ["join", "--as", "agent"];
const UNKNOWN_TOKEN = "cookout_unknown_to_this_board";
const PRIVATE_FILE = 0o600;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function claudeCodeIn(folder: string): Env {
  return { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: folder, COOKOUT_STATE_DIR: folder };
}

function revoked({ cookout }: Joined): Effect.Effect<void> {
  return Effect.asVoid(answer(() => cookout.client.revokeAgentSession("agent")));
}

const REFUSALS: readonly Refusal[] = [
  {
    refusedAs: "unknown, as after a restore",
    stale: (joined) =>
      Effect.andThen(revoked(joined), storeAgentSessionToken({ folder: joined.folder, token: UNKNOWN_TOKEN })),
  },
  { refusedAs: "revoked", stale: revoked },
];

const closedPortUrl = Effect.scoped(serverAnswering({ text: "closed once the scope ends" }));

const joinedAgent: Effect.Effect<Joined, never, TestCookout | CommandLineNeeds | Scope.Scope> = Effect.gen(
  function* joinAsAgent() {
    const cookout = yield* TestCookout;
    const { token } = yield* cookout.createIdentity("agent");
    const folder = yield* freshStateFolder;
    const env = { ...claudeCodeIn(folder), COOKOUT_URL: cookout.url };
    yield* runCookout({ args: JOIN, env: { ...env, COOKOUT_TOKEN: token } });
    return { cookout, env, folder, token };
  },
);

it.effect.each(REFUSALS)("join replaces a stored agent session token the board refuses as $refusedAs", ({ stale }) =>
  Effect.gen(function* joinOverStaleSession() {
    const joined = yield* joinedAgent;
    yield* stale(joined);
    const again = yield* runCookout({ args: JOIN, env: { ...joined.env, COOKOUT_TOKEN: joined.token } });
    const after = yield* runCookout({ args: ["whoami"], env: joined.env });

    expect([again, after]).toMatchObject([
      { exitCode: EXIT_SUCCESS, stdoutJson: { identity: "agent" } },
      { exitCode: EXIT_SUCCESS, stdoutJson: { identity: { name: "agent" }, source: "agent session token" } },
    ]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

it.effect("a join that can't ask the board about its stored agent session token leaves the file as it was", () =>
  Effect.gen(function* joinWithBoardOutOfReach() {
    const { env, folder, token } = yield* joinedAgent;
    const before = yield* storedAgentSessionStates(folder);
    const deadProxy = yield* closedPortUrl;
    const refused = yield* runCookout({ args: JOIN, env: { ...env, COOKOUT_TOKEN: token, HTTP_PROXY: deadProxy } });
    const after = yield* storedAgentSessionStates(folder);

    expect(refused).toMatchObject({ exitCode: EXIT_FAILURE, stderrJson: { error: { code: "unreachable" } } });
    expect(after).toStrictEqual(before);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

function credentialsWith({ defaultBoard, file }: Credentials): Effect.Effect<void, never, CommandLineNeeds> {
  return Effect.gen(function* writeCredentials() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* encodeJson({ defaultBoard, logins: {} });
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text, { mode: PRIVATE_FILE });
  }).pipe(Effect.orDie);
}

function loginAfterFirstRead({
  file,
  login,
}: {
  readonly file: string;
  readonly login: Effect.Effect<void, never, CommandLineNeeds>;
}): Effect.Effect<FileSystem.FileSystem, never, CommandLineNeeds> {
  return Effect.gen(function* fileSystemWithLogin() {
    const fs = yield* FileSystem.FileSystem;
    const services = yield* Effect.context<CommandLineNeeds>();
    const loggedIn = yield* Ref.make(false);
    const loginOnce = Effect.gen(function* loginUnlessDone() {
      if (!(yield* Ref.getAndSet(loggedIn, true))) {
        yield* Effect.provideContext(login, services);
      }
    });
    function readFileString(read: string, encoding?: string): ReturnType<FileSystem.FileSystem["readFileString"]> {
      const text = fs.readFileString(read, encoding);
      if (read === file) {
        return Effect.tap(text, () => loginOnce);
      }
      return text;
    }
    return { ...fs, readFileString };
  });
}

const joinedByDefaultBoard: Effect.Effect<LoggedIn, never, TestCookout | CommandLineNeeds | Scope.Scope> = Effect.gen(
  function* joinAtDefaultBoard() {
    const cookout = yield* TestCookout;
    const { token } = yield* cookout.createIdentity("agent");
    const [folder, config] = yield* Effect.all([freshStateFolder, freshStateFolder], { concurrency: 1 });
    const path = yield* Path.Path;
    const file = path.join(config, "cookout", "credentials");
    const env = { ...claudeCodeIn(folder), COOKOUT_TOKEN: token, XDG_CONFIG_HOME: config };
    yield* credentialsWith({ defaultBoard: cookout.url, file });
    yield* runCookout({ args: JOIN, env });
    return { cookout, env, file };
  },
);

it.effect(
  "join asks only the board it found its stored agent session for, though a login moves the default board",
  () =>
    Effect.gen(function* joinWhileLoggingIn() {
      const { cookout, env, file } = yield* joinedByDefaultBoard;
      const otherBoard = yield* forwardingProxy({ target: cookout.url });
      const racing = yield* loginAfterFirstRead({
        file,
        login: credentialsWith({ defaultBoard: otherBoard.url, file }),
      });
      const again = yield* runCookout({ args: JOIN, env }).pipe(Effect.provideService(FileSystem.FileSystem, racing));
      const askedOtherBoard = yield* otherBoard.forwarded;

      expect(again).toMatchObject({ exitCode: EXIT_FAILURE, stderrJson: { error: { code: "already_joined" } } });
      expect(askedOtherBoard).toStrictEqual([]);
    }).pipe(Effect.provide([testCookout(), commandLineServices])),
);

function joinOnRevoke(join: Effect.Effect<unknown>): (asked: string) => Effect.Effect<void> {
  return (asked) => {
    if (asked === `DELETE ${agentSessionPath}`) {
      return Effect.asVoid(join);
    }
    return Effect.void;
  };
}

it.effect("leave keeps the agent session token a join stored while the board answered the revoke", () =>
  Effect.gen(function* leaveWhileJoining() {
    const joined = yield* joinedAgent;
    const services = yield* Effect.context<CommandLineNeeds>();
    const joinAgain = runCookout({ args: JOIN, env: { ...joined.env, COOKOUT_TOKEN: joined.token } });
    const proxy = yield* forwardingProxy({
      beforeAnswering: joinOnRevoke(Effect.provideContext(joinAgain, services)),
      target: joined.cookout.url,
    });
    const left = yield* runCookout({ args: ["leave"], env: { ...joined.env, HTTP_PROXY: proxy.url } });
    const after = yield* runCookout({ args: ["whoami"], env: joined.env });

    expect([left, after]).toMatchObject([
      { exitCode: EXIT_SUCCESS, stdoutJson: { revoked: true } },
      { exitCode: EXIT_SUCCESS, stdoutJson: { identity: { name: "agent" }, source: "agent session token" } },
    ]);
  }).pipe(Effect.provide([testCookout(), commandLineServices])),
);
