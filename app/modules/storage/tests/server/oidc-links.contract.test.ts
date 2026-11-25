import { Array as Arr, Effect, Option, Struct } from "effect";
import type { HumanIdentity, Identity } from "../../../identities/index.ts";
import type { Storage, StorageUnavailable } from "../../server.ts";
import { expect, it } from "@effect/vitest";
import { identityName, isoTime, linkIdOf, openStore, storageLayers } from "../../../testing/server.ts";
import { tokenHash } from "../../../identities/index.ts";

type Store = Storage["Service"];

const now = isoTime("2026-01-01T00:00:00.000Z");
const later = isoTime("2026-02-01T00:00:00.000Z");
const ISSUER = "https://sign-in.example.com";
const OTHER_ISSUER = "https://other.example.com";
const SIGN_IN = "web UI (single sign-on)";
const FAILING_CALLS = 4;
const ada: HumanIdentity = { admin: false, createdAt: now, kind: "human", name: identityName("ada") };
const grace: HumanIdentity = { admin: false, createdAt: later, kind: "human", name: identityName("grace") };
const adaSub = { issuer: ISSUER, subject: "sub-ada" };
const graceSub = { issuer: ISSUER, subject: "sub-grace" };

interface Created {
  readonly human: HumanIdentity;
  readonly subject: Readonly<typeof adaSub>;
  readonly link?: string;
}

function createdLink(
  storage: Store,
  { human, link = `link-${human.name}`, subject }: Created,
): Effect.Effect<string, StorageUnavailable> {
  return storage.createLinkedHuman({
    ...subject,
    email: `${human.name}@example.com`,
    hash: tokenHash(`hash:${human.name}`),
    human,
    linkId: linkIdOf(link),
  });
}

function created(
  storage: Store,
  human: HumanIdentity,
  subject: Readonly<typeof adaSub>,
): Effect.Effect<string, StorageUnavailable> {
  return createdLink(storage, { human, subject });
}

function namesOf(found: readonly (Identity | undefined)[]): readonly (string | null)[] {
  return Arr.map(found, (held) => Option.getOrNull(Option.map(Option.fromUndefinedOr(held), Struct.get("name"))));
}

interface SignIn {
  readonly subject: string;
  readonly identity: string;
  readonly email?: string;
  readonly link?: string;
}

function signInSession(storage: Store, link: SignIn): Effect.Effect<string, StorageUnavailable> {
  return Effect.map(
    storage.issueLinkedLoginCredential({
      credentialHash: tokenHash(`session:${link.identity}:${link.subject}`),
      email: link.email ?? `${link.identity}@example.com`,
      host: SIGN_IN,
      identity: identityName(link.identity),
      issuer: ISSUER,
      linkId: linkIdOf(link.link ?? `link-${link.identity}`),
      now,
      subject: link.subject,
    }),
    (session) => {
      if (session.status === "issued") {
        return session.identity.name;
      }
      return session.status;
    },
  );
}

it.effect.each(storageLayers)(
  "storage contract ($adapter): a human created with its provider subject is found by that subject, with a token",
  ({ layer }) =>
    Effect.gen(function* createLinked() {
      const { storage } = yield* openStore(layer);
      const made = yield* created(storage, ada, adaSub);
      const found = yield* storage.findOidcLink(adaSub);
      const byToken = yield* storage.findIdentityByTokenHash(tokenHash("hash:ada"));
      const elsewhere = yield* storage.findOidcLink({ issuer: OTHER_ISSUER, subject: "sub-ada" });

      expect([made, found, byToken]).toStrictEqual([
        "created",
        { identity: ada, linkId: linkIdOf("link-ada") },
        { identity: ada, status: "active" },
      ]);
      expect(elsewhere).toBeUndefined();
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): creating a linked human refuses a subject already linked and a name already taken",
  ({ layer }) =>
    Effect.gen(function* createRefusals() {
      const { storage } = yield* openStore(layer);
      yield* created(storage, ada, adaSub);
      const sameSubject = yield* created(storage, grace, adaSub);
      const sameName = yield* created(storage, ada, { issuer: ISSUER, subject: "sub-other" });
      const graceFound = yield* storage.findIdentityByName(grace.name);
      const otherSubject = yield* storage.findOidcLink({ issuer: ISSUER, subject: "sub-other" });

      expect([sameSubject, sameName]).toStrictEqual(["subject_taken", "name_taken"]);
      expect(graceFound).toBeUndefined();
      expect(otherSubject).toBeUndefined();
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): deleting a human removes its link, so the subject makes a new human again",
  ({ layer }) =>
    Effect.gen(function* deleteUnlinks() {
      const { storage } = yield* openStore(layer);
      yield* created(storage, ada, adaSub);
      yield* storage.deleteIdentity(ada.name);
      const found = yield* storage.findOidcLink(adaSub);
      const again = yield* created(storage, ada, adaSub);

      expect(found).toBeUndefined();
      expect(again).toBe("created");
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): a link shows its email and when it was made, and only an issued session refreshes it",
  ({ layer }) =>
    Effect.gen(function* showLinks() {
      const { storage } = yield* openStore(layer);
      yield* Effect.all([created(storage, ada, adaSub), created(storage, grace, graceSub)], { concurrency: 1 });
      yield* storage.deactivateIdentity(ada.name);
      const outcomes = yield* Effect.all(
        [
          signInSession(storage, { email: "grace@new.example.com", identity: "grace", subject: "sub-grace" }),
          signInSession(storage, { email: "ada@new.example.com", identity: "ada", subject: "sub-ada" }),
          signInSession(storage, { email: "x@example.com", identity: "ada", subject: "sub-grace" }),
        ],
        { concurrency: 1 },
      );
      const graceShown = yield* storage.findOidcLinkOf({ identity: grace.name, issuer: ISSUER });
      const adaShown = yield* storage.findOidcLinkOf({ identity: ada.name, issuer: ISSUER });
      const elsewhere = yield* storage.findOidcLinkOf({ identity: grace.name, issuer: OTHER_ISSUER });

      expect(outcomes).toStrictEqual(["grace", "deactivated", "changed"]);
      expect([graceShown, adaShown]).toStrictEqual([
        { email: "grace@new.example.com", linkedAt: later },
        { email: "ada@example.com", linkedAt: now },
      ]);
      expect(elsewhere).toBeUndefined();
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): a sign-in session is issued only while the subject is still linked to that active human",
  ({ layer }) =>
    Effect.gen(function* issueOnlyWhileLinked() {
      const { storage } = yield* openStore(layer);
      yield* Effect.all([created(storage, ada, adaSub), created(storage, grace, graceSub)], { concurrency: 1 });
      const issued = yield* Effect.forEach(
        [
          { identity: "grace", subject: "sub-grace" },
          { identity: "ada", subject: "sub-ada" },
          { identity: "ada", subject: "sub-grace" },
          { identity: "grace", subject: "sub-nobody" },
        ] as const,
        (link) => signInSession(storage, link),
        { concurrency: 1 },
      );
      const held = yield* storage.findLoginCredential(tokenHash("session:grace:sub-grace"));

      expect([...issued, ...namesOf([held])]).toStrictEqual(["grace", "ada", "changed", "changed", "grace"]);
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): no sign-in session for a human deactivated, or deleted and made again, after its link, each saying why",
  ({ layer }) =>
    Effect.gen(function* noSessionAfterChanges() {
      const { storage } = yield* openStore(layer);
      yield* Effect.all([created(storage, ada, adaSub), created(storage, grace, graceSub)], { concurrency: 1 });
      yield* storage.deactivateIdentity(ada.name);
      const deactivated = yield* signInSession(storage, { identity: "ada", subject: "sub-ada" });
      yield* storage.deleteIdentity(grace.name);
      yield* storage.createIdentity(grace, tokenHash("hash:grace-again"));
      const recreated = yield* signInSession(storage, { identity: "grace", subject: "sub-grace" });

      expect([deactivated, recreated]).toStrictEqual(["deactivated", "changed"]);
    }),
);

it.effect.each(storageLayers)(
  "storage contract ($adapter): a session is issued only for the link the sign-in found, not one made again since, even in the same millisecond",
  ({ layer }) =>
    Effect.gen(function* onlyTheFoundLink() {
      const { storage } = yield* openStore(layer);
      yield* created(storage, ada, adaSub);
      const found = yield* storage.findOidcLink(adaSub);
      yield* storage.deleteIdentity(ada.name);
      yield* createdLink(storage, { human: ada, link: "link-ada-again", subject: adaSub });
      const stale = yield* signInSession(storage, { identity: "ada", subject: "sub-ada" });
      const current = yield* signInSession(storage, { identity: "ada", link: "link-ada-again", subject: "sub-ada" });

      expect([found, stale, current]).toStrictEqual([
        { identity: ada, linkId: linkIdOf("link-ada") },
        "changed",
        "ada",
      ]);
    }),
);

it.effect.each(storageLayers)("storage contract ($adapter): a closed store can't keep OIDC links", ({ layer }) =>
  Effect.gen(function* closed() {
    const { close, storage } = yield* openStore(layer);
    yield* close;
    const failures = yield* Effect.all(
      [
        Effect.flip(storage.findOidcLink(adaSub)),
        Effect.flip(created(storage, ada, adaSub)),
        Effect.flip(storage.findOidcLinkOf({ identity: ada.name, issuer: ISSUER })),
        Effect.flip(signInSession(storage, { identity: "ada", subject: "sub-ada" })),
      ],
      { concurrency: 1 },
    );

    expect(failures).toMatchObject(Array.from({ length: FAILING_CALLS }, () => ({ _tag: "StorageUnavailable" })));
  }),
);
