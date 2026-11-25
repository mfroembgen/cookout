import { Array as Arr, Duration, Effect, Fiber, Layer, Option } from "effect";
import type { FakeUser, FinishedOidcSignIn, StartedOidcSignIn } from "../../../testing/server.ts";
import {
  OidcFake,
  TestCookout,
  answer,
  authorizeAt,
  finishOidcSignIn,
  signedInAs,
  silentServer,
  startOidcSignIn,
  testCookout,
  testCookoutWithOidc,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import type { HttpClient } from "effect/http";
import { NodeHttpClient } from "@effect/platform-node";
import { TestClock } from "effect/testing";
import { request } from "../../../http/client.ts";

const FOUND = 302;
const TOO_MANY = 429;
const UNAVAILABLE = 503;
const SIGN_IN_MINUTES = 10;
const PROVIDER_SECONDS = 10;
const BOARD = "https://board.example.com";
const ADA: FakeUser = { email: "ada@example.com", emailVerified: true };

const returnedAsAda = Effect.gen(function* returnAsAda() {
  const cookout = yield* TestCookout;
  const fake = yield* OidcFake;
  yield* fake.signInAs(ADA);
  const started = yield* startOidcSignIn(cookout.url);
  const { callbackUrl } = yield* authorizeAt(started.providerUrl);
  return { callbackUrl, cookie: started.stateCookie, url: cookout.url };
});

function refusedTo(finished: FinishedOidcSignIn): readonly unknown[] {
  return [finished.response.status, finished.response.headers.get("location"), finished.sessionCookie];
}

function toLoginView(code: string): readonly unknown[] {
  return [FOUND, `${BOARD}/#/login/${code}`, Option.none()];
}

it.effect("a sign-in whose state isn't the one this browser started is refused, to the login view", () =>
  Effect.gen(function* wrongState() {
    const returned = yield* returnedAsAda;
    const callbackUrl = new URL(returned.callbackUrl);
    callbackUrl.searchParams.set("state", "a-state-from-elsewhere");
    const finished = yield* finishOidcSignIn({ ...returned, callbackUrl: callbackUrl.href });

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_state_mismatch"));
    expect(finished.response.json).toMatchObject({ error: { code: "oidc_state_mismatch" } });
    expect(finished.response.headers.getSetCookie()).toStrictEqual([
      expect.stringMatching(/^__Host-cookout_oidc=;.*Max-Age=0/u),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a callback with its state twice is refused as a mismatch, clearing the sign-in cookie", () =>
  Effect.gen(function* duplicateState() {
    const cookout = yield* TestCookout;
    const returned = yield* returnedAsAda;
    const sent = new URL(returned.callbackUrl);
    const path = `${sent.pathname}${sent.search}&state=another-state`;
    const response = yield* answer(() =>
      request({ baseUrl: cookout.url, headers: { cookie: returned.cookie }, method: "GET", path }),
    );

    expect([response.status, response.headers.get("location")]).toStrictEqual([
      FOUND,
      `${BOARD}/#/login/oidc_state_mismatch`,
    ]);
    expect(response.headers.getSetCookie()).toStrictEqual([
      expect.stringMatching(/^__Host-cookout_oidc=;.*Max-Age=0/u),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a sign-in cookie that isn't one this server sealed is refused, whatever it says", () =>
  Effect.gen(function* forgedCookie() {
    const returned = yield* returnedAsAda;
    const tampered = `${returned.cookie}0`;
    const garbled = yield* finishOidcSignIn({ ...returned, cookie: "__Host-cookout_oidc=not-a-sign-in" });
    const forged = yield* finishOidcSignIn({ ...returned, cookie: tampered });

    expect(Arr.map([garbled, forged], refusedTo)).toStrictEqual([
      toLoginView("oidc_state_mismatch"),
      toLoginView("oidc_state_mismatch"),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a sign-in with no sign-in cookie, or one finished after its 10 minutes, is refused", () =>
  Effect.gen(function* noCookie() {
    const returned = yield* returnedAsAda;
    const missing = yield* finishOidcSignIn({ ...returned, cookie: "" });
    yield* TestClock.adjust(Duration.minutes(SIGN_IN_MINUTES));
    const expired = yield* finishOidcSignIn(returned);

    expect(Arr.map([missing, expired], refusedTo)).toStrictEqual([
      toLoginView("oidc_state_missing"),
      toLoginView("oidc_state_missing"),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a sign-in that comes back naming another issuer is refused", () =>
  Effect.gen(function* otherIssuer() {
    const fake = yield* OidcFake;
    yield* fake.sendIssuer("https://evil.example.com");
    const finished = yield* signedInAs(ADA);

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_issuer_mismatch"));
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a provider's error comes back to the login view, naming it", () =>
  Effect.gen(function* providerError() {
    const fake = yield* OidcFake;
    yield* fake.refuseNext("access_denied");
    const finished = yield* signedInAs(ADA);

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_provider_refused"));
    expect(finished.response.json).toMatchObject({ error: { details: { error: "access_denied" } } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a callback that brings back neither a code nor an error is refused", () =>
  Effect.gen(function* noCode() {
    const returned = yield* returnedAsAda;
    const callbackUrl = new URL(returned.callbackUrl);
    callbackUrl.searchParams.delete("code");
    const finished = yield* finishOidcSignIn({ ...returned, callbackUrl: callbackUrl.href });

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_provider_refused"));
    expect(finished.response.json).toMatchObject({ error: { details: { error: "no_code" } } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an email address the provider doesn't call verified is refused, a verified one said as text too", () =>
  Effect.gen(function* unverified() {
    const unverifiedSignIn = yield* signedInAs({ email: "ada@example.com", emailVerified: false });
    const saidAsText = yield* signedInAs({ email: "ada@example.com", emailVerified: "true" });

    expect(Arr.map([unverifiedSignIn, saidAsText], refusedTo)).toStrictEqual([
      toLoginView("oidc_email_unverified"),
      toLoginView("oidc_email_unverified"),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an address outside the email domain is refused, and so is one at a subdomain of it", () =>
  Effect.gen(function* foreignDomain() {
    const foreign = yield* signedInAs({ email: "ada@other.com", emailVerified: true });
    const subdomain = yield* signedInAs({ email: "ada@mail.example.com", emailVerified: true });
    const lookalike = yield* signedInAs({ email: "ada@badexample.com", emailVerified: true });
    const noAt = yield* signedInAs({ email: "ada.example.com", emailVerified: true });

    const refused = [foreign, subdomain, lookalike, noAt];

    expect(Arr.map(refused, refusedTo)).toStrictEqual(Arr.map(refused, () => toLoginView("oidc_email_not_allowed")));
    expect(foreign.response.json).toMatchObject({
      error: { message: "Only an email address at example.com can sign in here." },
    });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an address whose name can't be an identity name is refused", () =>
  Effect.gen(function* unusableName() {
    const finished = yield* signedInAs({ email: "ada+board@example.com", emailVerified: true });

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_name_unusable"));
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a discovery document naming another issuer, or an endpoint that isn't https, is refused", () =>
  Effect.gen(function* badDiscovery() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.announce({ issuer: "https://other.example.com" });
    const otherIssuer = yield* startOidcSignIn(cookout.url);
    yield* fake.announce({ token_endpoint: "http://sign-in.example.com/token" });
    const plainEndpoint = yield* startOidcSignIn(cookout.url);

    expect(Arr.map([otherIssuer, plainEndpoint], ({ providerUrl }) => providerUrl)).toStrictEqual([
      `${BOARD}/#/login/oidc_provider_failed`,
      `${BOARD}/#/login/oidc_provider_failed`,
    ]);
    expect(plainEndpoint.response.json).toMatchObject({ error: { details: { step: "discovery document" } } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

function startedAgainstSilence(
  asked: Effect.Effect<void>,
): Effect.Effect<StartedOidcSignIn, never, TestCookout | HttpClient.HttpClient> {
  return Effect.gen(function* startAgainstSilence() {
    const cookout = yield* TestCookout;
    const starting = yield* Effect.forkChild(startOidcSignIn(cookout.url));
    yield* asked;
    yield* TestClock.adjust(Duration.seconds(PROVIDER_SECONDS));
    return yield* Fiber.join(starting);
  });
}

it.effect("a provider that doesn't answer within 10 seconds is refused", () =>
  Effect.gen(function* silentProvider() {
    const silent = yield* silentServer();
    const oidc = {
      client: "cookout",
      clientSecret: Option.none(),
      emailDomain: "example.com",
      issuer: silent.url,
      label: "single sign-on",
    };
    const silentCookout = testCookout({ oidc: { ...oidc, publicUrl: BOARD }, publicUrl: BOARD });
    const started = yield* Effect.provide(
      startedAgainstSilence(silent.asked),
      Layer.merge(silentCookout, NodeHttpClient.layerNodeHttp),
    );

    expect(started.providerUrl).toBe(`${BOARD}/#/login/oidc_provider_failed`);
  }).pipe(Effect.scoped),
);

function finishedAfterStart(): Effect.Effect<
  FinishedOidcSignIn,
  never,
  OidcFake | TestCookout | HttpClient.HttpClient
> {
  return Effect.gen(function* startThenComeBack() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.signInAs(ADA);
    const started = yield* startOidcSignIn(cookout.url);
    const { callbackUrl } = yield* authorizeAt(started.providerUrl);
    return yield* finishOidcSignIn({ callbackUrl, cookie: started.stateCookie, url: cookout.url });
  });
}

function statusAndClearing(finished: FinishedOidcSignIn): readonly unknown[] {
  return [finished.response.status, finished.response.headers.getSetCookie()];
}

const CLEARED = [expect.stringMatching(/^__Host-cookout_oidc=;.*Max-Age=0/u)];

it.effect("a callback over the address's request limit keeps its 429 and clears the sign-in cookie", () =>
  Effect.gen(function* limited() {
    const finished = yield* finishedAfterStart();

    expect(statusAndClearing(finished)).toStrictEqual([TOO_MANY, CLEARED]);
  }).pipe(Effect.provide(testCookoutWithOidc({ requestsPerMinute: 1 }))),
);

it.effect("a callback that storage fails keeps its 503 and clears the sign-in cookie", () =>
  Effect.gen(function* storageDown() {
    const finished = yield* finishedAfterStart();

    expect(statusAndClearing(finished)).toStrictEqual([UNAVAILABLE, CLEARED]);
  }).pipe(Effect.provide(testCookoutWithOidc({ storage: "sign-in-unavailable" }))),
);
