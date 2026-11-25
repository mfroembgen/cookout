import { Effect, Option, Ref } from "effect";
import type { FakeKeys } from "./keys.ts";
import { Secrets } from "../../../secrets/server.ts";

interface FakeUser {
  readonly email: string;
  readonly emailVerified: unknown;
  readonly name?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly subject?: string;
}

interface Grant {
  readonly challenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly user: FakeUser;
}

interface IdTokenChanges {
  readonly omit?: true;
  readonly otherKey?: true;
  readonly rotated?: true;
  readonly rekeyed?: true;
  readonly expired?: true;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly without?: readonly string[];
}

interface FakeProviderOptions {
  readonly client: string;
  readonly clientSecret: Option.Option<string>;
}

interface FakeState {
  readonly keys: FakeKeys;
  readonly options: FakeProviderOptions;
  readonly issuer: Effect.Effect<string>;
  readonly setIssuer: (issuer: string) => Effect.Effect<void>;
  readonly announced: Effect.Effect<Readonly<Record<string, string>>>;
  readonly announce: (fields: Readonly<Record<string, string>>) => Effect.Effect<void>;
  readonly nextIdToken: (changes: IdTokenChanges) => Effect.Effect<void>;
  readonly takeIdTokenChanges: Effect.Effect<IdTokenChanges>;
  readonly sentIssuer: Effect.Effect<Option.Option<string>>;
  readonly sendIssuer: (issuer: string) => Effect.Effect<void>;
  readonly user: Effect.Effect<FakeUser>;
  readonly signInAs: (user: FakeUser) => Effect.Effect<void>;
  readonly refuseNext: (error: string) => Effect.Effect<void>;
  readonly takeRefusal: Effect.Effect<Option.Option<string>>;
  readonly counted: (prefix: string) => Effect.Effect<string>;
  readonly grant: (code: string, grant: Grant) => Effect.Effect<void>;
  readonly takeGrant: (code: string) => Effect.Effect<Option.Option<Grant>>;
  readonly holdToken: (token: string, user: FakeUser) => Effect.Effect<void>;
  readonly userOf: (token: string) => Effect.Effect<Option.Option<FakeUser>>;
  readonly challengeOf: (verifier: string) => Effect.Effect<string>;
}

const STEP = 1;
const NONE_YET = 0;
const NO_USER: FakeUser = { email: "nobody@example.com", emailVerified: false };

interface FakeStateOf {
  readonly keys: FakeKeys;
  readonly options: FakeProviderOptions;
}

function nextCount(count: number): number {
  return count + STEP;
}

function challengeWith(secrets: Secrets["Service"]): (verifier: string) => Effect.Effect<string> {
  return (verifier) => Effect.map(secrets.digest(verifier), (hex) => Buffer.from(hex, "hex").toString("base64url"));
}

function fakeState({ keys, options }: FakeStateOf): Effect.Effect<FakeState, never, Secrets> {
  return Effect.gen(function* holdFakeState() {
    const secrets = yield* Secrets;
    const { announced, counter, grants, idTokenChanges, issuer, refusal, sentIssuer, tokens, user } = yield* Effect.all(
      {
        announced: Ref.make<Readonly<Record<string, string>>>({}),
        counter: Ref.make(NONE_YET),
        grants: Ref.make<ReadonlyMap<string, Grant>>(new Map()),
        idTokenChanges: Ref.make<IdTokenChanges>({}),
        issuer: Ref.make(""),
        refusal: Ref.make(Option.none<string>()),
        sentIssuer: Ref.make(Option.none<string>()),
        tokens: Ref.make<ReadonlyMap<string, FakeUser>>(new Map()),
        user: Ref.make(NO_USER),
      },
      { concurrency: 1 },
    );
    return {
      announce: (fields) => Ref.set(announced, fields),
      announced: Ref.get(announced),
      challengeOf: challengeWith(secrets),
      counted: (prefix) => Effect.map(Ref.updateAndGet(counter, nextCount), (count) => `${prefix}-${String(count)}`),
      grant: (code, given) => Ref.update(grants, (values) => new Map([...values, [code, given]])),
      holdToken: (token, given) => Ref.update(tokens, (values) => new Map([...values, [token, given]])),
      issuer: Ref.get(issuer),
      keys,
      nextIdToken: (changes) => Ref.set(idTokenChanges, changes),
      options,
      refuseNext: (error) => Ref.set(refusal, Option.some(error)),
      sendIssuer: (given) => Ref.set(sentIssuer, Option.some(given)),
      sentIssuer: Ref.get(sentIssuer),
      setIssuer: (given) => Ref.set(issuer, given),
      signInAs: (given) => Ref.set(user, given),
      takeGrant: (code) =>
        Ref.modify(grants, (values) => {
          const rest = new Map(values);
          rest.delete(code);
          return [Option.fromUndefinedOr(values.get(code)), rest];
        }),
      takeIdTokenChanges: Ref.getAndSet(idTokenChanges, {}),
      takeRefusal: Ref.getAndSet(refusal, Option.none()),
      user: Ref.get(user),
      userOf: (token) => Effect.map(Ref.get(tokens), (held) => Option.fromUndefinedOr(held.get(token))),
    };
  });
}

export { type FakeProviderOptions, type FakeState, type FakeUser, type Grant, type IdTokenChanges, fakeState };
