import { Array as Arr, Effect, Schema } from "effect";
import { OIDC_LINKS_MIGRATION, POSTGRES_OIDC_LINKS_MIGRATION } from "./oidc-links.ts";
import type { Fails } from "./errors.ts";
import type { PostgresDatabase } from "./adapters/postgres.ts";
import type { SqlDatabase } from "./adapters/sql-database.ts";
import type { SqliteDatabase } from "./adapters/sqlite.ts";
import { StorageUnavailable } from "./errors.ts";

const NO_VERSION = 0;

const FORK_VERSION_TABLE = `CREATE TABLE IF NOT EXISTS fork_schema_version (
  only_row integer PRIMARY KEY CHECK (only_row = 1),
  version integer NOT NULL
)`;
const FIRST_FORK_VERSION = "INSERT INTO fork_schema_version (only_row, version) VALUES (1, 0) ON CONFLICT DO NOTHING";
const FORK_VERSION = "SELECT version FROM fork_schema_version";
const SET_FORK_VERSION = "UPDATE fork_schema_version SET version = ?";

const sqliteForkMigrations: readonly (readonly string[])[] = [[OIDC_LINKS_MIGRATION]];

const postgresForkMigrations: readonly (readonly string[])[] = [POSTGRES_OIDC_LINKS_MIGRATION];

const ForkVersionRow = Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(NO_VERSION)) });

const unreadableVersion = StorageUnavailable.make({ message: "The database has no readable fork schema version." });

function forkVersion(db: SqlDatabase): Fails<number> {
  return Effect.gen(function* readForkVersion() {
    yield* db.exec(FORK_VERSION_TABLE);
    yield* db.exec(FIRST_FORK_VERSION);
    const row = yield* db.get(FORK_VERSION);
    return yield* Schema.decodeUnknownEffect(ForkVersionRow)(row).pipe(
      Effect.mapBoth({ onFailure: () => unreadableVersion, onSuccess: ({ version }) => version }),
    );
  });
}

function appliedFork(db: SqlDatabase, steps: readonly (readonly string[])[]): Fails<void> {
  return Effect.gen(function* applyForkMigrations() {
    const current = yield* forkVersion(db);
    if (current > steps.length) {
      return yield* StorageUnavailable.make({
        message: `The database is at fork schema version ${current}, newer than this cookout (${steps.length}). Upgrade cookout.`,
      });
    }
    const pending = Arr.flatten(Arr.drop(steps, current));
    yield* Effect.forEach(pending, (statement) => db.exec(statement), { concurrency: 1, discard: true });
    return yield* db.run(SET_FORK_VERSION, steps.length);
  });
}

function migrateForkSqlite(db: SqliteDatabase): Fails<void> {
  return db.transaction(appliedFork(db, sqliteForkMigrations));
}

function migrateForkPostgres(db: PostgresDatabase): Fails<void> {
  return db.migrating(appliedFork(db, postgresForkMigrations));
}

export { migrateForkPostgres, migrateForkSqlite };
