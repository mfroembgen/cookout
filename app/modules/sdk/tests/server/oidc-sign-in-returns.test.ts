import type { FakeUser, FinishedOidcSignIn } from "../../../testing/server.ts";
import {
  OidcFake,
  TestCookout,
  answer,
  authorizeAt,
  finishOidcSignIn,
  startOidcSignInBackTo,
  testCookoutWithOidc,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { HttpResponse } from "../../../http/client.ts";
import { oidcStartPath } from "../../../oidc/index.ts";
import { request } from "../../../http/client.ts";

const FOUND = 302;
const BOARD = "https://board.example.com";
const ADA: FakeUser = { email: "ada@example.com", emailVerified: true };

const HOMEPAGE = `${BOARD}/`;
const RETURNS = [
  "#/approve/ABCD-1234",
  "#/approve-join/WXYZ-9876",
  "https://elsewhere.example.com/",
  "#/inbox",
  "#/approve/abcd-1234",
  "#/approve/ABCD-1234/more",
  "/#/approve/ABCD-1234",
] as const;

it.effect("a sign-in started from an approval page comes back to it, and any other return to the homepage", () =>
  Effect.gen(function* backToTheApproval() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    const landed = yield* Effect.forEach(
      RETURNS,
      (back) =>
        Effect.gen(function* signInFrom() {
          yield* fake.signInAs(ADA);
          const started = yield* startOidcSignInBackTo(back);
          const { callbackUrl } = yield* authorizeAt(started.providerUrl);
          const finished = yield* finishOidcSignIn({ callbackUrl, cookie: started.stateCookie, url: cookout.url });
          return finished.response.headers.get("location");
        }),
      { concurrency: 1 },
    );

    expect(landed).toStrictEqual([
      `${BOARD}/#/approve/ABCD-1234`,
      `${BOARD}/#/approve-join/WXYZ-9876`,
      HOMEPAGE,
      HOMEPAGE,
      HOMEPAGE,
      HOMEPAGE,
      HOMEPAGE,
    ]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

const APPROVAL = "#/approve/ABCD-1234";

function fromApproval(url: string): Effect.Effect<FinishedOidcSignIn, never, TestCookout | HttpClient.HttpClient> {
  return Effect.gen(function* signInFromApproval() {
    const started = yield* startOidcSignInBackTo(APPROVAL);
    const { callbackUrl } = yield* authorizeAt(started.providerUrl);
    return yield* finishOidcSignIn({ callbackUrl, cookie: started.stateCookie, url });
  });
}

const LOOPBACK_BOARD = "http://127.0.0.1:4173";

function startedOnOwnHost(url: string): Effect.Effect<HttpResponse> {
  return answer(() => request({ baseUrl: url, method: "GET", path: oidcStartPath, query: { return: APPROVAL } }));
}

it.effect(
  "on a loopback public URL, a sign-in started on another loopback host goes to the public URL's host first, with no cookie",
  () =>
    Effect.gen(function* canonicalHostFirst() {
      const cookout = yield* TestCookout;
      const elsewhere = yield* startedOnOwnHost(cookout.url);
      const started = yield* startOidcSignInBackTo(APPROVAL);

      expect([
        elsewhere.status,
        elsewhere.headers.get("location"),
        elsewhere.headers.getSetCookie(),
        elsewhere.headers.get("cache-control"),
      ]).toStrictEqual([FOUND, `${LOOPBACK_BOARD}${oidcStartPath}?return=%23%2Fapprove%2FABCD-1234`, [], "no-store"]);
      expect([started.response.status, started.stateCookie]).toStrictEqual([
        FOUND,
        expect.stringMatching(/^cookout_oidc=./u),
      ]);
    }).pipe(Effect.provide(testCookoutWithOidc({ publicUrl: LOOPBACK_BOARD }))),
);

it.effect("on an https public URL, a sign-in on another Host, as behind a proxy, goes straight to the provider", () =>
  Effect.gen(function* behindAProxy() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    const started = yield* startedOnOwnHost(cookout.url);

    expect([started.status, started.headers.get("location")]).toStrictEqual([
      FOUND,
      expect.stringMatching(new RegExp(`^${fake.issuer}/`, "u")),
    ]);
    expect(started.headers.getSetCookie()).toStrictEqual([expect.stringMatching(/^__Host-cookout_oidc=./u)]);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an issuer mismatch on a sign-in from an approval page keeps the page for signing in again", () =>
  Effect.gen(function* issuerMismatchKeepsPage() {
    const cookout = yield* TestCookout;
    const fake = yield* OidcFake;
    yield* fake.signInAs(ADA);
    yield* fake.sendIssuer("https://elsewhere.example.com");
    const refused = yield* fromApproval(cookout.url);

    expect(refused.response.headers.get("location")).toBe(`${BOARD}/#/login/oidc_issuer_mismatch/approve/ABCD-1234`);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect(
  "a sign-in from an approval page refused at the provider keeps the page, so signing in again comes back to it",
  () =>
    Effect.gen(function* refusedThenAgain() {
      const cookout = yield* TestCookout;
      const fake = yield* OidcFake;
      yield* fake.refuseNext("access_denied");
      const shown = yield* fromApproval(cookout.url);
      yield* fake.signInAs(ADA);
      const finished = yield* fromApproval(cookout.url);

      expect([shown.response.headers.get("location"), finished.response.headers.get("location")]).toStrictEqual([
        `${BOARD}/#/login/oidc_provider_refused/approve/ABCD-1234`,
        `${BOARD}/${APPROVAL}`,
      ]);
    }).pipe(Effect.provide(testCookoutWithOidc())),
);
