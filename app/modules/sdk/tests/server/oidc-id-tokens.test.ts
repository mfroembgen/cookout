import { Duration, Effect, Option } from "effect";
import type { IdTokenChanges, TestCookout } from "../../../testing/server.ts";
import { OidcFake, signedInAs, testCookoutWithOidc } from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import type { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";

const FOUND = 302;
const BOARD = "https://board.example.com";
const ADA = { email: "ada@example.com", emailVerified: true };
const KEYS_KEPT_MINUTES = 10;

function signedAs(): Effect.Effect<string | null, never, OidcFake | TestCookout | HttpClient.HttpClient> {
  return Effect.map(signedInAs(ADA), ({ response }) => response.headers.get("location"));
}

const BAD_ID_TOKENS: readonly { readonly name: string; readonly changes: IdTokenChanges }[] = [
  { changes: { omit: true }, name: "no ID token" },
  { changes: { otherKey: true }, name: "an ID token signed with a key the provider doesn't publish" },
  { changes: { claims: { aud: "another-client" } }, name: "an ID token for another client" },
  {
    changes: { claims: { aud: ["cookout-test-client", "another-client"] } },
    name: "an ID token for two clients and no azp",
  },
  {
    changes: { claims: { aud: ["cookout-test-client", "another-client"], azp: "cookout-test-client" } },
    name: "an ID token for two clients, even with this one as its azp",
  },
  { changes: { claims: { azp: "another-client" } }, name: "an ID token whose azp is another client" },
  {
    changes: { claims: { aud: ["cookout-test-client", "cookout-test-client"] } },
    name: "an ID token whose audience lists this client twice",
  },
  { changes: { without: ["exp"] }, name: "an ID token with no exp" },
  { changes: { without: ["iat"] }, name: "an ID token with no iat" },
  { changes: { claims: { iss: "https://evil.example.com" } }, name: "an ID token from another issuer" },
  { changes: { expired: true }, name: "an expired ID token" },
  { changes: { claims: { nonce: "another-nonce" } }, name: "an ID token for another sign-in's nonce" },
  { changes: { claims: { nonce: null } }, name: "an ID token with no nonce" },
  { changes: { claims: { sub: "fake|someone-else" } }, name: "an ID token for another subject than the userinfo's" },
];

it.effect.each(BAD_ID_TOKENS)("a sign-in with $name is refused", ({ changes }) =>
  Effect.gen(function* refusedIdToken() {
    const fake = yield* OidcFake;
    yield* fake.nextIdToken(changes);
    const finished = yield* signedInAs(ADA);

    expect([finished.response.status, finished.response.headers.get("location"), finished.sessionCookie]).toStrictEqual(
      [FOUND, `${BOARD}/#/login/oidc_id_token_invalid`, Option.none()],
    );
    expect(finished.response.json).toMatchObject({ error: { code: "oidc_id_token_invalid" } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an ID token signed with a key the provider published after the cookout read its keys signs in", () =>
  Effect.gen(function* rotatedKey() {
    const fake = yield* OidcFake;
    const first = yield* signedAs();
    yield* fake.nextIdToken({ rotated: true });
    const second = yield* signedAs();

    expect([first, second]).toStrictEqual([`${BOARD}/`, `${BOARD}/`]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect(
  "the cookout keeps the provider's keys 10 minutes, so a key ID given a new key works once they're read again",
  () =>
    Effect.gen(function* rekeyed() {
      const fake = yield* OidcFake;
      const first = yield* signedAs();
      yield* fake.nextIdToken({ rekeyed: true });
      const stale = yield* signedAs();
      yield* TestClock.adjust(Duration.minutes(KEYS_KEPT_MINUTES));
      const fresh = yield* signedAs();

      expect([first, stale, fresh]).toStrictEqual([`${BOARD}/`, `${BOARD}/#/login/oidc_id_token_invalid`, `${BOARD}/`]);
    }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("keys the provider doesn't serve are a provider failure at the JWKS step", () =>
  Effect.gen(function* missingKeys() {
    const fake = yield* OidcFake;
    yield* fake.announce({ jwks_uri: `${fake.issuer}/no-keys` });
    const finished = yield* signedInAs(ADA);

    expect([finished.response.headers.get("location"), finished.response.json]).toMatchObject([
      `${BOARD}/#/login/oidc_provider_failed`,
      { error: { details: { step: "JWKS" } } },
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an ID token for only this client, as a one-entry list with this client as its azp, signs in", () =>
  Effect.gen(function* oneAudience() {
    const fake = yield* OidcFake;
    yield* fake.nextIdToken({ claims: { aud: ["cookout-test-client"], azp: "cookout-test-client" } });
    const finished = yield* signedInAs(ADA);

    expect(finished.response.headers.get("location")).toBe(`${BOARD}/`);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);
