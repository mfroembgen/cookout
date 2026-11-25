import { Effect, Layer, Option } from "effect";
import { StorageUnavailable, postgresStorage, sqliteStorage } from "../../server.ts";
import {
  emptyPostgresDatabase,
  freshDatabasePath,
  identityName,
  isoTime,
  linkIdOf,
  onPostgresDatabase,
  openStore,
} from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import type { HumanIdentity } from "../../../identities/index.ts";
import { NodeServices } from "@effect/platform-node";
import type { Storage } from "../../server.ts";
import { tokenHash } from "../../../identities/index.ts";

const ISSUER = "https://sign-in.example.com";
const ada: HumanIdentity = {
  admin: false,
  createdAt: isoTime("2026-01-01T00:00:00.000Z"),
  kind: "human",
  name: identityName("ada"),
};
const FORK_VERSION_IS_ONE = `DO $$ BEGIN
  IF (SELECT version FROM fork_schema_version) <> 1 THEN RAISE EXCEPTION 'fork schema version is not 1'; END IF;
END $$`;
const BEFORE_THE_FORK = ["DROP TABLE oidc_links", "DROP TABLE fork_schema_version"];

function linkedAfterOpening(
  layer: Layer.Layer<Storage, StorageUnavailable>,
): Effect.Effect<string, StorageUnavailable> {
  return Effect.scoped(
    Effect.gen(function* openAndLink() {
      const { close, storage } = yield* openStore(layer);
      const made = yield* storage.createLinkedHuman({
        email: "ada@example.com",
        hash: tokenHash("hash:ada"),
        human: ada,
        issuer: ISSUER,
        linkId: linkIdOf("link-ada"),
        subject: "sub-ada",
      });
      yield* close;
      return made;
    }),
  );
}

function reopened(layer: Layer.Layer<Storage, StorageUnavailable>): Effect.Effect<string, StorageUnavailable> {
  return Effect.scoped(
    Effect.gen(function* openAgain() {
      const { close, storage } = yield* openStore(layer);
      const found = yield* storage.findOidcLink({ issuer: ISSUER, subject: "sub-ada" });
      yield* close;
      return Option.getOrElse(
        Option.map(Option.fromUndefinedOr(found), (link) => link.identity.name),
        () => "none",
      );
    }),
  );
}

it.effect("a SQLite database gets the fork's migrations once, and opening it again changes nothing", () =>
  Effect.scoped(
    Effect.gen(function* sqliteForkOnce() {
      const path = yield* freshDatabasePath;
      const onDisk = Layer.provide(sqliteStorage(path), NodeServices.layer);
      const made = yield* linkedAfterOpening(onDisk);
      const again = yield* Effect.all([reopened(onDisk), reopened(onDisk)], { concurrency: 1 });

      expect([made, ...again]).toStrictEqual(["created", "ada", "ada"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a Postgres database at upstream's latest version without the fork gets its migrations exactly once", () =>
  Effect.scoped(
    Effect.gen(function* postgresForkOnce() {
      const url = yield* emptyPostgresDatabase;
      yield* reopened(url.pipe(postgresStorage));
      yield* onPostgresDatabase({ statements: BEFORE_THE_FORK, url });
      const made = yield* linkedAfterOpening(url.pipe(postgresStorage));
      const again = yield* reopened(url.pipe(postgresStorage));
      yield* onPostgresDatabase({ statements: [FORK_VERSION_IS_ONE], url });

      expect([made, again]).toStrictEqual(["created", "ada"]);
    }),
  ),
);

it.effect("a Postgres database at a newer fork schema version than this cookout fails with StorageUnavailable", () =>
  Effect.scoped(
    Effect.gen(function* forkTooNew() {
      const url = yield* emptyPostgresDatabase;
      yield* reopened(url.pipe(postgresStorage));
      yield* onPostgresDatabase({ statements: ["UPDATE fork_schema_version SET version = 1000"], url });
      const error = yield* Effect.flip(reopened(url.pipe(postgresStorage)));

      expect(error).toStrictEqual(
        StorageUnavailable.make({
          message: "The database is at fork schema version 1000, newer than this cookout (1). Upgrade cookout.",
        }),
      );
    }),
  ),
);
