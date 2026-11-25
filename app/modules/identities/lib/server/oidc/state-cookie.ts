import { Array as Arr, DateTime, Duration, Effect, Number as Num, Option, String as Str } from "effect";
import type { OidcSettings } from "./settings.ts";
import { Secrets } from "../../../../secrets/server.ts";
import { SignInSeal } from "./seal.ts";
import { signInReturnOf } from "../../../../oidc/index.ts";

interface SignInState {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly returnTo: string;
}

interface SentCookies {
  readonly cookies: Readonly<Record<string, string | undefined>>;
  readonly settings: OidcSettings;
}

type Parts = readonly [string, string, string, string, string];

interface StartedSignIn extends SignInState {
  readonly challenge: string;
}

interface StateCookieOptions {
  readonly httpOnly: true;
  readonly path: "/";
  readonly sameSite: "lax";
  readonly secure: boolean;
}

interface StateCookie {
  readonly name: string;
  readonly options: StateCookieOptions;
}

const LIFETIME_MINUTES = 10;
const SEPARATOR = ".";
const PARTS = 5;
const SECURE_NAME = "__Host-cookout_oidc";
const PLAIN_NAME = "cookout_oidc";

const stateCookieLifetime = Duration.minutes(LIFETIME_MINUTES);

function stateCookieOf(settings: OidcSettings): StateCookie {
  const secure = new URL(settings.publicUrl).protocol === "https:";
  const options: StateCookieOptions = { httpOnly: true, path: "/", sameSite: "lax", secure };
  if (secure) {
    return { name: SECURE_NAME, options };
  }
  return { name: PLAIN_NAME, options };
}

function startedSignIn(returnTo: string): Effect.Effect<StartedSignIn, never, Secrets> {
  return Effect.gen(function* startSignIn() {
    const secrets = yield* Secrets;
    const state = yield* secrets.newToken;
    const nonce = yield* secrets.newToken;
    const verifier = yield* Effect.flatMap(secrets.newToken, secrets.digest);
    const challengeHex = yield* secrets.digest(verifier);
    const now = yield* DateTime.now;
    return {
      challenge: Buffer.from(challengeHex, "hex").toString("base64url"),
      expiresAt: DateTime.toEpochMillis(DateTime.addDuration(now, stateCookieLifetime)),
      nonce,
      returnTo,
      state,
      verifier,
    };
  });
}

function stateCookieValue(started: SignInState): Effect.Effect<string, never, SignInSeal> {
  const { expiresAt, nonce, returnTo, state, verifier } = started;
  const back = Buffer.from(returnTo).toString("base64url");
  const value = Arr.join([state, verifier, nonce, String(expiresAt), back], SEPARATOR);
  return Effect.flatMap(SignInSeal, (seal) => seal.sealed(value));
}

function isParts(parts: readonly string[]): parts is Parts {
  return parts.length === PARTS;
}

function parsed(value: string): Option.Option<SignInState> {
  return Option.flatMap(
    Option.liftPredicate(Str.split(SEPARATOR)(value), isParts),
    ([state, verifier, nonce, expiresAt, back]) =>
      Option.map(Num.parse(expiresAt), (expiry) => ({
        expiresAt: expiry,
        nonce,
        returnTo: signInReturnOf(Buffer.from(back, "base64url").toString()),
        state,
        verifier,
      })),
  );
}

type SentState =
  | { readonly status: "missing" }
  | { readonly status: "forged" }
  | { readonly status: "sent"; readonly signIn: SignInState };

const MISSING: SentState = { status: "missing" };
const FORGED: SentState = { status: "forged" };

function sentState({ cookies, settings }: SentCookies): Effect.Effect<SentState, never, SignInSeal> {
  return Effect.gen(function* readSentState() {
    const sent = Option.fromUndefinedOr(cookies[stateCookieOf(settings).name]);
    if (Option.isNone(sent)) {
      return MISSING;
    }
    const seal = yield* SignInSeal;
    const unsealed = yield* seal.opened(sent.value);
    const opened = Option.flatMap(unsealed, parsed);
    const now = yield* DateTime.now;
    return Option.match(opened, {
      onNone: () => FORGED,
      onSome: (signIn): SentState => {
        if (DateTime.toEpochMillis(now) >= signIn.expiresAt) {
          return MISSING;
        }
        return { signIn, status: "sent" };
      },
    });
  });
}

export {
  type SignInState,
  type StartedSignIn,
  sentState,
  startedSignIn,
  stateCookieLifetime,
  stateCookieOf,
  stateCookieValue,
};
