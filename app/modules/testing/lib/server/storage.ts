import { Context, Effect, Exit, FileSystem, Layer, Option, Path, Scope, String as Str } from "effect";
import type { QueryPlan, ScheduledRun } from "../../../storage/server.ts";
import {
  Storage,
  StorageUnavailable,
  memoryAssetStore,
  memoryStorage,
  postgresQueryPlans,
  postgresStorage,
  sqliteQueryPlans,
  sqliteStorage,
} from "../../../storage/server.ts";
import { fixtureOwnerName, identityFixture, identityName } from "./identities.ts";
import type { OidcLinkId } from "../../../oidc/index.ts";
import { freshPostgresDatabase } from "./postgres.ts";
import { isOidcLinkId } from "../../../oidc/index.ts";
import { layer as nodeServices } from "@effect/platform-node/NodeServices";
import { tokenHash } from "../../../identities/index.ts";

interface StorageLayer {
  readonly adapter: "memory" | "sqlite" | "postgres";
  readonly layer: Layer.Layer<Storage, StorageUnavailable>;
  readonly emptyLayer: Layer.Layer<Storage, StorageUnavailable>;
}

interface OpenStore {
  readonly close: Effect.Effect<void>;
  readonly storage: Storage["Service"];
}

const freshDatabasePath: Effect.Effect<string, never, FileSystem.FileSystem | Path.Path | Scope.Scope> = Effect.gen(
  function* makeDatabasePath() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "cookout-sqlite-" });
    return path.join(folder, "cookout.db");
  },
).pipe(Effect.orDie);

const freshSqliteStorage: Layer.Layer<Storage, StorageUnavailable> = Layer.unwrap(
  Effect.map(freshDatabasePath, sqliteStorage),
).pipe(Layer.provide(nodeServices));

function withFixtureOwner<Failure>(
  layer: Layer.Layer<Storage, Failure>,
): Layer.Layer<Storage, Failure | StorageUnavailable> {
  return Layer.tap(layer, (context) =>
    Context.get(context, Storage).createIdentity(
      identityFixture(fixtureOwnerName, { kind: "human" }),
      tokenHash("fixture-owner-token-hash"),
    ),
  );
}

const freshPostgresStorage: Layer.Layer<Storage, StorageUnavailable> = Layer.unwrap(
  Effect.map(freshPostgresDatabase, postgresStorage),
);

const postgresLayer: StorageLayer = {
  adapter: "postgres",
  emptyLayer: freshPostgresStorage,
  layer: withFixtureOwner(freshPostgresStorage),
};

const storageLayers: readonly StorageLayer[] = [
  { adapter: "memory", emptyLayer: memoryStorage, layer: withFixtureOwner(memoryStorage) },
  { adapter: "sqlite", emptyLayer: freshSqliteStorage, layer: withFixtureOwner(freshSqliteStorage) },
  postgresLayer,
];

const unusableStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    checkHealth: (): Effect.Effect<never, StorageUnavailable> =>
      Effect.fail(StorageUnavailable.make({ message: "The test made this store unusable." })),
  })),
).pipe(Layer.provide(memoryStorage));

const signInUnavailableStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    findOidcLink: (): Effect.Effect<never, StorageUnavailable> =>
      Effect.fail(StorageUnavailable.make({ message: "The test made sign-in storage unusable." })),
  })),
).pipe(Layer.provide(memoryStorage));

const pausedMidRunStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    runScheduledMessage: (run: ScheduledRun): ReturnType<Storage["Service"]["runScheduledMessage"]> =>
      Effect.andThen(storage.pauseScheduledMessage(run.id, run.due), storage.runScheduledMessage(run)),
  })),
).pipe(Layer.provide(memoryStorage));

const EDITED_TEXT = "edited mid-run";

function editingText(storage: Storage["Service"], run: ScheduledRun): Effect.Effect<void> {
  return Effect.flatMap(Effect.flatMap(storage.findScheduledMessage(run.id), Effect.fromNullishOr), (schedule) =>
    Effect.when(
      Effect.asVoid(storage.editScheduledMessage(run.id, { ...schedule, text: EDITED_TEXT }, run.due)),
      Effect.succeed(schedule.text !== EDITED_TEXT),
    ),
  ).pipe(Effect.asVoid, Effect.orDie);
}

const editedMidRunStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    runScheduledMessage: (run: ScheduledRun): ReturnType<Storage["Service"]["runScheduledMessage"]> =>
      Effect.andThen(editingText(storage, run), storage.runScheduledMessage(run)),
  })),
).pipe(Layer.provide(memoryStorage));

function deactivatingCreator(storage: Storage["Service"], run: ScheduledRun): Effect.Effect<void> {
  return Effect.flatMap(Effect.flatMap(storage.findScheduledMessage(run.id), Effect.fromNullishOr), ({ creator }) =>
    Effect.asVoid(storage.deactivateIdentity(creator)),
  ).pipe(Effect.orDie);
}

const deactivatedMidRunStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    runScheduledMessage: (run: ScheduledRun): ReturnType<Storage["Service"]["runScheduledMessage"]> =>
      Effect.andThen(deactivatingCreator(storage, run), storage.runScheduledMessage(run)),
  })),
).pipe(Layer.provide(memoryStorage));

const FIRST_ARGUMENT = 0;

type CreatedHuman = Parameters<Storage["Service"]["createLinkedHuman"]>[typeof FIRST_ARGUMENT];

const LINK_ID_LENGTH = 64;
const HALF_LINK_ID = 32;

const deletedMidSignInStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    createLinkedHuman: (created: CreatedHuman) =>
      Effect.tap(storage.createLinkedHuman(created), () => storage.deleteIdentity(created.human.name)),
  })),
).pipe(Layer.provide(memoryStorage));

const deactivatedMidSignInStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    createLinkedHuman: (created: CreatedHuman) =>
      Effect.tap(storage.createLinkedHuman(created), () => storage.deactivateIdentity(created.human.name)),
  })),
).pipe(Layer.provide(memoryStorage));

function otherLinkId(linkId: OidcLinkId): OidcLinkId {
  const other = Str.padStart(LINK_ID_LENGTH, "0")(Str.takeLeft(linkId, HALF_LINK_ID));
  return Option.getOrThrow(Option.liftPredicate(other, isOidcLinkId));
}

const racedMidSignInStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    createLinkedHuman: (created: CreatedHuman) =>
      Effect.andThen(
        storage.createLinkedHuman({
          ...created,
          human: { ...created.human, name: identityName(`${created.human.name}-first`) },
          linkId: otherLinkId(created.linkId),
        }),
        storage.createLinkedHuman(created),
      ),
  })),
).pipe(Layer.provide(memoryStorage));

const recreatedMidSignInStorage: Layer.Layer<Storage> = Layer.effect(
  Storage,
  Effect.map(Storage, (storage) => ({
    ...storage,
    createLinkedHuman: (created: CreatedHuman) =>
      Effect.tap(storage.createLinkedHuman(created), () =>
        Effect.andThen(
          storage.deleteIdentity(created.human.name),
          storage.createLinkedHuman({ ...created, linkId: otherLinkId(created.linkId) }),
        ),
      ),
  })),
).pipe(Layer.provide(memoryStorage));

function freshSqliteQueryPlans<Failure>(
  work: (storage: Storage["Service"]) => Effect.Effect<unknown, Failure>,
): Effect.Effect<readonly QueryPlan[], Failure | StorageUnavailable, FileSystem.FileSystem | Path.Path> {
  return Effect.scoped(Effect.flatMap(freshDatabasePath, (path) => sqliteQueryPlans({ path, work })));
}

function freshPostgresQueryPlans<Failure>(
  work: (storage: Storage["Service"]) => Effect.Effect<unknown, Failure>,
): Effect.Effect<readonly QueryPlan[], Failure | StorageUnavailable> {
  return Effect.scoped(Effect.flatMap(freshPostgresDatabase, (url) => postgresQueryPlans({ url, work })));
}

function openStore<Failure, Needs>(
  layer: Layer.Layer<Storage, Failure, Needs>,
): Effect.Effect<OpenStore, Failure, Needs> {
  return Effect.gen(function* buildStore() {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    return { close: Scope.close(scope, Exit.void), storage: Context.get(context, Storage) };
  });
}

const memoryAssets = memoryAssetStore;

export {
  deactivatedMidRunStorage,
  deactivatedMidSignInStorage,
  deletedMidSignInStorage,
  racedMidSignInStorage,
  recreatedMidSignInStorage,
  editedMidRunStorage,
  freshDatabasePath,
  freshPostgresQueryPlans,
  freshSqliteQueryPlans,
  memoryAssets,
  openStore,
  pausedMidRunStorage,
  storageLayers,
  signInUnavailableStorage,
  unusableStorage,
};
