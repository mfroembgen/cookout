import { Array as Arr, Effect, Layer, Option, Record as Rec, String as Str } from "effect";
import {
  OidcFake,
  TestCookout,
  answer,
  authorizeAt,
  finishOidcSignIn,
  signedInAs,
  startOidcSignIn,
  testCookout,
  testCookoutWithOidc,
  whoamiAfter,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import type { FakeUser } from "../../../testing/server.ts";
import type { HttpResponse } from "../../../http/client.ts";
import { NodeHttpClient } from "@effect/platform-node";

const OIDC_OFF = Layer.merge(testCookout(), NodeHttpClient.layerNodeHttp);
const FOUND = 302;
const NOT_FOUND = 404;
const BOARD = "https://board.example.com";
const LOOPBACK_BOARD = "http://127.0.0.1:4173";
const ADA: FakeUser = { email: "Ada.Lovelace@Example.com", emailVerified: true, name: "  Ada Lovelace  " };

function cookieAttributes(response: HttpResponse, name: string): readonly string[] {
  const found = Arr.findFirst(response.headers.getSetCookie(), Str.startsWith(`${name}=`));
  return Str.split("; ")(Option.getOrElse(found, () => ""));
}

it.effect("with single sign-on off, the sign-in answer says so and the OIDC routes are no route's", () =>
  Effect.gen(function* oidcOff() {
    const cookout = yield* TestCookout;
    const signIn = yield* answer(cookout.clientFor().signIn);
    const started = yield* startOidcSignIn(cookout.url);
    const returned = yield* finishOidcSignIn({ callbackUrl: BOARD, cookie: "", url: cookout.url });

    expect(signIn).toStrictEqual({ oidc: false });
    expect([started.response.status, returned.response.status]).toStrictEqual([NOT_FOUND, NOT_FOUND]);
    expect(started.response.json).toMatchObject({ error: { code: "not_found" } });
  }).pipe(Effect.provide(OIDC_OFF)),
);

it.effect("with single sign-on on, the sign-in answer says so and names the provider, with no token", () =>
  Effect.gen(function* oidcOn() {
    const cookout = yield* TestCookout;
    const signIn = yield* answer(cookout.clientFor().signIn);

    expect(signIn).toStrictEqual({ label: "Google", oidc: true, start: `${BOARD}/v1/oidc/start` });
  }).pipe(Effect.provide(testCookoutWithOidc({ label: "Google" }))),
);

it.effect("starting a sign-in sends the browser to the provider with PKCE S256, state and a nonce", () =>
  Effect.gen(function* startsSignIn() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    const started = yield* startOidcSignIn(cookout.url);
    const providerUrl = new URL(started.providerUrl);
    const { code_challenge: challenge = "", nonce, state, ...params } = Rec.fromEntries(providerUrl.searchParams);

    expect([started.response.status, `${providerUrl.origin}${providerUrl.pathname}`]).toStrictEqual([
      FOUND,
      `${fake.issuer}/authorize`,
    ]);
    expect(params).toStrictEqual({
      client_id: fake.client,
      code_challenge_method: "S256",
      redirect_uri: `${BOARD}/v1/oidc/callback`,
      response_type: "code",
      scope: "openid email profile",
    });
    expect([challenge, nonce, state]).toStrictEqual([
      expect.stringMatching(/^[\w-]{43}$/u),
      expect.any(String),
      expect.any(String),
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("on https a sign-in keeps its state in a sealed 10-minute __Host- cookie: Secure, HttpOnly, Lax", () =>
  Effect.gen(function* keepsState() {
    const cookout = yield* TestCookout;
    const started = yield* startOidcSignIn(cookout.url);
    const state = new URL(started.providerUrl).searchParams.get("state") ?? "";

    expect(started.stateCookie).toMatch(new RegExp(`^__Host-cookout_oidc=${state}\\..+\\.[0-9a-f]{64}$`, "u"));
    expect(cookieAttributes(started.response, "__Host-cookout_oidc")).toStrictEqual(
      expect.arrayContaining(["Max-Age=600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]),
    );
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a first sign-in makes a human, never an admin, named by the email address, and logs the web UI in", () =>
  Effect.gen(function* firstSignIn() {
    const cookout = yield* TestCookout;
    const finished = yield* signedInAs(ADA);
    const whoami = yield* whoamiAfter(finished);
    const { identities } = yield* answer(() => cookout.client.listIdentities());

    expect([finished.response.status, finished.response.headers.get("location")]).toStrictEqual([FOUND, `${BOARD}/`]);
    expect(whoami).toMatchObject({
      identity: { admin: false, displayName: "Ada Lovelace", kind: "human", name: "ada-lovelace" },
    });
    expect(Arr.map(identities, ({ name }) => name)).toStrictEqual(["ada-lovelace", "admin"]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("with no name claim, a new human's display name is its given and family names, trimmed, or none", () =>
  Effect.gen(function* namesFromParts() {
    const users: readonly FakeUser[] = [
      { email: "grace@example.com", emailVerified: true, familyName: " Hopper ", givenName: " Grace " },
      { email: "alan@example.com", emailVerified: true, familyName: "  ", givenName: "Alan", name: "  " },
      { email: "nameless@example.com", emailVerified: true, givenName: " " },
    ];
    const cookout = yield* TestCookout;
    yield* Effect.forEach(users, signedInAs, { concurrency: 1 });
    const made = yield* Effect.forEach(
      ["grace", "alan", "nameless"],
      (name) => answer(() => cookout.client.getIdentity(name)),
      { concurrency: 1 },
    );

    expect(Arr.map(made, ({ identity }) => identity.displayName ?? null)).toStrictEqual(["Grace Hopper", "Alan", null]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a new human's display name comes from the ID token's names first, then the userinfo's", () =>
  Effect.gen(function* namesFromTheIdToken() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.nextIdToken({ claims: { family_name: "Turing", given_name: "Alan" } });
    yield* signedInAs({ email: "alan@example.com", emailVerified: true, name: "From Userinfo" });
    yield* fake.nextIdToken({ claims: { name: "  " } });
    yield* signedInAs({ email: "grace@example.com", emailVerified: true, name: "Grace Hopper" });
    const made = yield* Effect.forEach(["alan", "grace"], (name) => answer(() => cookout.client.getIdentity(name)), {
      concurrency: 1,
    });

    expect(Arr.map(made, ({ identity }) => identity.displayName ?? null)).toStrictEqual([
      "Alan Turing",
      "Grace Hopper",
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a later sign-in keeps the display name the person set, whatever the provider says", () =>
  Effect.gen(function* keepsName() {
    const cookout = yield* TestCookout;
    yield* signedInAs(ADA);
    yield* answer(() => cookout.client.setDisplayName("ada-lovelace", "The Countess"));
    const later = yield* signedInAs(ADA);
    const whoami = yield* whoamiAfter(later);

    expect(whoami).toMatchObject({ identity: { displayName: "The Countess" } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a finished sign-in sets a Secure web session cookie on https and clears the sign-in cookie", () =>
  Effect.gen(function* cookies() {
    const finished = yield* signedInAs(ADA);

    expect(cookieAttributes(finished.response, "cookout_session")).toStrictEqual(
      expect.arrayContaining(["HttpOnly", "SameSite=Strict", "Path=/", "Secure"]),
    );
    expect(cookieAttributes(finished.response, "__Host-cookout_oidc")).toStrictEqual(
      expect.arrayContaining(["__Host-cookout_oidc=", "Max-Age=0", "Path=/", "Secure"]),
    );
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("on a loopback http public URL the cookies have their plain names and aren't Secure", () =>
  Effect.gen(function* loopback() {
    const cookout = yield* TestCookout;
    const started = yield* startOidcSignIn(cookout.url);
    const finished = yield* signedInAs(ADA);

    expect(started.stateCookie).toMatch(/^cookout_oidc=/u);
    expect([
      cookieAttributes(started.response, "cookout_oidc").includes("Secure"),
      cookieAttributes(finished.response, "cookout_session").includes("Secure"),
      finished.response.headers.get("location"),
    ]).toStrictEqual([false, false, `${LOOPBACK_BOARD}/`]);
  }).pipe(Effect.provide(testCookoutWithOidc({ publicUrl: LOOPBACK_BOARD }))),
);

it.effect("a later sign-in of the same provider account signs in as the human its first one made", () =>
  Effect.gen(function* laterSignIn() {
    const cookout = yield* TestCookout;
    const first = yield* signedInAs(ADA);
    const second = yield* signedInAs(ADA);
    const whoami = yield* Effect.forEach([first, second], whoamiAfter, { concurrency: 1 });
    const { identities } = yield* answer(() => cookout.client.listIdentities());

    const [firstWhoami, secondWhoami] = whoami;

    expect(firstWhoami).toMatchObject({ identity: { name: "ada-lovelace" } });
    expect(secondWhoami).toStrictEqual(firstWhoami);
    expect(Arr.map(identities, ({ name }) => name)).toStrictEqual(["ada-lovelace", "admin"]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("with a client secret, the cookout sends it to the token endpoint and the sign-in works", () =>
  Effect.gen(function* confidentialClient() {
    const finished = yield* signedInAs(ADA);

    expect([finished.response.headers.get("location"), Option.isSome(finished.sessionCookie)]).toStrictEqual([
      `${BOARD}/`,
      true,
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc({ clientSecret: "fake-client-secret" }))),
);

it.effect("a callback sent again with its cookie is refused, since the provider's code is good once", () =>
  Effect.gen(function* replayed() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.signInAs(ADA);
    const started = yield* startOidcSignIn(cookout.url);
    const { callbackUrl } = yield* authorizeAt(started.providerUrl);
    const returned = { callbackUrl, cookie: started.stateCookie, url: cookout.url };
    const first = yield* finishOidcSignIn(returned);
    const again = yield* finishOidcSignIn(returned);

    expect(Arr.map([first, again], ({ response }) => response.headers.get("location"))).toStrictEqual([
      `${BOARD}/`,
      `${BOARD}/#/login/oidc_provider_failed`,
    ]);
    expect(again.response.json).toMatchObject({ error: { details: { step: "token endpoint" } } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);
