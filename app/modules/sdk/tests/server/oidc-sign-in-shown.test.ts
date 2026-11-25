import { Array as Arr, Effect, Function, Option, Predicate } from "effect";
import type { FakeUser, FinishedOidcSignIn } from "../../../testing/server.ts";
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
import { request } from "../../../http/client.ts";

const ADA: FakeUser = { email: "Ada@Example.com", emailVerified: true, subject: "ada-at-the-provider" };

function readWithCookie(finished: FinishedOidcSignIn, path: string): Effect.Effect<unknown, never, TestCookout> {
  return Effect.gen(function* readAsTheWebUi() {
    const cookout = yield* TestCookout;
    const cookie = Option.getOrElse(finished.sessionCookie, Function.constant(""));
    const response = yield* answer(() => request({ baseUrl: cookout.url, headers: { cookie }, method: "GET", path }));
    return response.json;
  });
}

function cachingOf(finished: FinishedOidcSignIn, path: string): Effect.Effect<string | null, never, TestCookout> {
  return Effect.gen(function* readHeaders() {
    const cookout = yield* TestCookout;
    const cookie = Option.getOrElse(finished.sessionCookie, Function.constant(""));
    const response = yield* answer(() => request({ baseUrl: cookout.url, headers: { cookie }, method: "GET", path }));
    return response.headers.get("cache-control");
  });
}

it.effect("no cache keeps the sign-in's answers or the reads that carry its email", () =>
  Effect.gen(function* neverStored() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.signInAs(ADA);
    const started = yield* startOidcSignIn(cookout.url);
    const { callbackUrl } = yield* authorizeAt(started.providerUrl);
    const finished = yield* finishOidcSignIn({ callbackUrl, cookie: started.stateCookie, url: cookout.url });
    const refused = yield* finishOidcSignIn({ callbackUrl, cookie: "", url: cookout.url });
    const reads = yield* Effect.all([cachingOf(finished, "/v1/whoami"), cachingOf(finished, "/v1/identities/ada")], {
      concurrency: 1,
    });
    const caching = [
      ...Arr.map([started, finished, refused], ({ response }) => response.headers.get("cache-control")),
      ...reads,
    ];

    expect(caching).toStrictEqual(Arr.map(caching, () => "no-store"));
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a signed-in human sees how it signs in, the verified email and when it was linked, and so do admins", () =>
  Effect.gen(function* shownToSelfAndAdmins() {
    const cookout = yield* TestCookout;
    const finished = yield* signedInAs(ADA);
    const whoami = yield* whoamiAfter(finished);
    const own = yield* readWithCookie(finished, "/v1/identities/ada");
    const byAdmin = yield* answer(() => cookout.client.getIdentity("ada"));
    const { identity } = byAdmin;

    expect(whoami).toStrictEqual({ identity, signIn: { email: "ada@example.com", linkedAt: identity.createdAt } });
    expect([own, byAdmin]).toStrictEqual([whoami, whoami]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("another human, an agent and an unlinked human's own reads show no sign-in", () =>
  Effect.gen(function* hiddenFromOthers() {
    const cookout = yield* TestCookout;
    yield* signedInAs(ADA);
    const bob = yield* cookout.createIdentity("bob", { kind: "human" });
    const bot = yield* cookout.createIdentity("bob-bot", { kind: "agent", owner: "bob" });
    const shown = yield* Effect.all(
      [
        answer(() => bob.client.getIdentity("ada")),
        answer(() => bot.client.getIdentity("ada")),
        answer(() => bob.client.whoami()),
        answer(() => cookout.client.getIdentity("admin")),
        answer(() => cookout.client.getIdentity("bob-bot")),
      ],
      { concurrency: 1 },
    );

    expect(Arr.map(shown, (response) => Predicate.hasProperty(response, "signIn"))).toStrictEqual(
      Arr.map(shown, Function.constFalse),
    );
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("each sign-in keeps the email the provider verified last", () =>
  Effect.gen(function* refreshed() {
    yield* signedInAs(ADA);
    const later = yield* signedInAs({ ...ADA, email: "countess@example.com" });
    const whoami = yield* whoamiAfter(later);

    expect(whoami).toMatchObject({ identity: { name: "ada" }, signIn: { email: "countess@example.com" } });
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("with single sign-on off, an admin reading a human sees no sign-in", () =>
  Effect.gen(function* oidcOff() {
    const cookout = yield* TestCookout;
    yield* cookout.createIdentity("grace", { kind: "human" });
    const shown = yield* answer(() => cookout.client.getIdentity("grace"));

    expect(Predicate.hasProperty(shown, "signIn")).toBe(false);
  }).pipe(Effect.provide(testCookout())),
);
