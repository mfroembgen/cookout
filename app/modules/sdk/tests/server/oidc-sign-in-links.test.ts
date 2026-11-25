import { Array as Arr, Effect, Option, String as Str } from "effect";
import type { FakeUser, FinishedOidcSignIn } from "../../../testing/server.ts";
import { TestCookout, answer, signedInAs, testCookoutWithOidc, whoamiAfter } from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";

const FOUND = 302;
const BOARD = "https://board.example.com";
const GRACE: FakeUser = { email: "grace@example.com", emailVerified: true };

function refusedTo(finished: FinishedOidcSignIn): readonly unknown[] {
  return [finished.response.status, finished.response.headers.get("location"), finished.sessionCookie];
}

function toLoginView(code: string): readonly unknown[] {
  return [FOUND, `${BOARD}/#/login/${code}`, Option.none()];
}

it.effect("an existing human, admin included, is refused as a name taken and keeps its token login", () =>
  Effect.gen(function* existingHuman() {
    const cookout = yield* TestCookout;
    const grace = yield* cookout.createIdentity("grace", { admin: true, kind: "human" });
    const refused = yield* signedInAs(GRACE);
    const { identity } = yield* answer(grace.client.whoami);

    expect(refusedTo(refused)).toStrictEqual(toLoginView("oidc_name_taken"));
    expect(refused.response.text).toContain("Ask an admin");
    expect(identity).toStrictEqual(grace.identity);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("single sign-on never makes an admin: admin@ the domain is refused as a name taken", () =>
  Effect.gen(function* adminAddress() {
    const finished = yield* signedInAs({ email: "admin@example.com", emailVerified: true });

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_name_taken"));
    expect(finished.response.text).toContain("Ask an admin");
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("an address that names an agent is refused as a name taken, and the agent is left as it was", () =>
  Effect.gen(function* agentName() {
    const cookout = yield* TestCookout;
    const bot = yield* cookout.createIdentity("release-bot", { owner: "admin" });
    const finished = yield* signedInAs({ email: "release-bot@example.com", emailVerified: true });
    const { identity } = yield* answer(bot.client.whoami);

    expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_name_taken"));
    expect(identity).toStrictEqual(bot.identity);
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a linked human who is then deactivated can't sign in", () =>
  Effect.gen(function* deactivatedHuman() {
    const cookout = yield* TestCookout;
    yield* signedInAs(GRACE);
    yield* answer(() => cookout.client.deactivateIdentity("grace"));
    const finished = yield* signedInAs(GRACE);

    expect(refusedTo(finished)).toStrictEqual(toLoginView("identity_deactivated"));
  }).pipe(Effect.provide(testCookoutWithOidc())),
);

it.effect("a human deactivated while its sign-in comes back is refused as deactivated, with no session", () =>
  Effect.gen(function* deactivatedMeanwhile() {
    const finished = yield* signedInAs(GRACE);

    expect(refusedTo(finished)).toStrictEqual(toLoginView("identity_deactivated"));
  }).pipe(Effect.provide(testCookoutWithOidc({ storage: "deactivated-mid-sign-in" }))),
);

it.effect("a first sign-in that loses the race to make the account's human signs in as the human the winner made", () =>
  Effect.gen(function* lostTheRace() {
    const finished = yield* signedInAs(GRACE);
    const whoami = yield* whoamiAfter(finished);

    expect([finished.response.status, finished.response.headers.get("location")]).toStrictEqual([FOUND, `${BOARD}/`]);
    expect(whoami).toMatchObject({ identity: { name: "grace-first" } });
  }).pipe(Effect.provide(testCookoutWithOidc({ storage: "raced-mid-sign-in" }))),
);

it.effect(
  "a first sign-in whose new link is deleted and made again for the same account before its session is refused as changed",
  () =>
    Effect.gen(function* recreatedMeanwhile() {
      const finished = yield* signedInAs(GRACE);

      expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_sign_in_changed"));
    }).pipe(Effect.provide(testCookoutWithOidc({ storage: "recreated-mid-sign-in" }))),
);

it.effect(
  "a human deleted while its first sign-in comes back is refused as changed, with the sign-in cookie cleared",
  () =>
    Effect.gen(function* deletedMeanwhile() {
      const finished = yield* signedInAs(GRACE);
      const cleared = Arr.findFirst(finished.response.headers.getSetCookie(), Str.startsWith("__Host-cookout_oidc="));

      expect(refusedTo(finished)).toStrictEqual(toLoginView("oidc_sign_in_changed"));
      expect(Option.map(cleared, Str.split("; "))).toStrictEqual(
        Option.some(expect.arrayContaining(["__Host-cookout_oidc=", "Max-Age=0"])),
      );
    }).pipe(Effect.provide(testCookoutWithOidc({ storage: "deleted-mid-sign-in" }))),
);
