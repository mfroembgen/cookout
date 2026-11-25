import { TestCookout, startOidcSignIn, testCookoutWithOidc } from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

const FOUND = 302;
const BOARD = "https://board.example.com";

it.effect("a provider off loopback whose name resolves to loopback is refused when the cookout connects to it", () =>
  Effect.gen(function* privateByName() {
    const cookout = yield* TestCookout;
    const started = yield* startOidcSignIn(cookout.url);

    expect([started.response.status, started.response.headers.get("location"), started.stateCookie]).toStrictEqual([
      FOUND,
      `${BOARD}/#/login/oidc_provider_failed`,
      "__Host-cookout_oidc=",
    ]);
    expect(started.response.json).toMatchObject({
      error: { details: { step: "discovery document, on a private address" } },
    });
  }).pipe(Effect.provide(testCookoutWithOidc({ issuerHost: "localhost." }))),
);

it.effect("the same provider on its loopback address is reached, as a loopback issuer skips the guard", () =>
  Effect.gen(function* loopbackIssuer() {
    const cookout = yield* TestCookout;
    const started = yield* startOidcSignIn(cookout.url);

    expect([started.response.status, started.stateCookie]).toStrictEqual([
      FOUND,
      expect.stringMatching(/^__Host-cookout_oidc=.+/u),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a provider whose name doesn't resolve is a provider failure, not a crash", () =>
  Effect.gen(function* unresolvable() {
    const cookout = yield* TestCookout;
    const started = yield* startOidcSignIn(cookout.url);

    expect([started.response.status, started.response.headers.get("location")]).toStrictEqual([
      FOUND,
      `${BOARD}/#/login/oidc_provider_failed`,
    ]);
    expect(started.response.json).toMatchObject({ error: { details: { step: "discovery document" } } });
  }).pipe(Effect.provide(testCookoutWithOidc({ issuerHost: "provider.invalid" }))),
);
