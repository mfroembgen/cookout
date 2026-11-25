import { Effect, Option, Predicate, Schema } from "effect";
import type { HumanIdentity, Identity, IdentityName, TokenHash } from "../../../identities/index.ts";
import { IDENTITY_COLUMNS, IdentityRow, toIdentity } from "./identity-row.ts";
import type { Fails } from "./errors.ts";
import type { IsoTime } from "../../../time/index.ts";
import { IsoTimeSchema } from "../../../time/server.ts";
import type { OidcLinkId } from "../../../oidc/index.ts";
import type { SqlDatabase } from "./adapters/sql-database.ts";
import { isOidcLinkId } from "../../../oidc/index.ts";
import { unreadable } from "./errors.ts";

interface OidcSubject {
  readonly issuer: string;
  readonly subject: string;
}

interface SignedInSubject extends OidcSubject {
  readonly email: string;
}

interface FoundLink {
  readonly identity: Identity;
  readonly linkId: OidcLinkId;
}

interface LinkedCredential extends SignedInSubject {
  readonly identity: IdentityName;
  readonly linkId: OidcLinkId;
  readonly credentialHash: TokenHash;
  readonly host: string;
  readonly now: IsoTime;
}

interface NewLinkedHuman extends SignedInSubject {
  readonly human: HumanIdentity;
  readonly hash: TokenHash;
  readonly linkId: OidcLinkId;
}

interface LinkOf {
  readonly issuer: string;
  readonly identity: IdentityName;
}

interface ShownLink {
  readonly email: string;
  readonly linkedAt: IsoTime;
}

type LinkedHumanResult = "created" | "subject_taken" | "name_taken";

interface RefusedSession {
  readonly linked: Identity | undefined;
  readonly identity: IdentityName;
}

type LinkedSession =
  | { readonly status: "issued"; readonly identity: Identity }
  | { readonly status: "deactivated" }
  | { readonly status: "changed" };

interface OidcLinksSection {
  readonly findOidcLink: (subject: OidcSubject) => Fails<FoundLink | undefined>;
  readonly createLinkedHuman: (created: NewLinkedHuman) => Fails<LinkedHumanResult>;
  readonly findOidcLinkOf: (link: LinkOf) => Fails<ShownLink | undefined>;
  readonly issueLinkedLoginCredential: (issued: LinkedCredential) => Fails<LinkedSession>;
}

const OIDC_LINKS_MIGRATION = `CREATE TABLE oidc_links (
   issuer TEXT NOT NULL,
   subject TEXT NOT NULL,
   identity_name TEXT NOT NULL REFERENCES identities (name) ON DELETE CASCADE,
   link_id TEXT NOT NULL UNIQUE,
   created_at TEXT NOT NULL,
   email TEXT NOT NULL,
   PRIMARY KEY (issuer, subject)
 ) STRICT;
 CREATE UNIQUE INDEX oidc_links_by_identity ON oidc_links (issuer, identity_name);`;

const POSTGRES_OIDC_LINKS_MIGRATION: readonly string[] = [
  `CREATE TABLE oidc_links (
     issuer text COLLATE "C" NOT NULL,
     subject text COLLATE "C" NOT NULL,
     identity_name text COLLATE "C" NOT NULL REFERENCES identities (name) ON DELETE CASCADE,
     link_id text COLLATE "C" NOT NULL UNIQUE,
     created_at text COLLATE "C" NOT NULL,
     email text COLLATE "C" NOT NULL,
     PRIMARY KEY (issuer, subject)
   )`,
  "CREATE UNIQUE INDEX oidc_links_by_identity ON oidc_links (issuer, identity_name)",
];

const FIND_LINKED = `SELECT ${IDENTITY_COLUMNS} FROM identities
  WHERE name = (SELECT identity_name FROM oidc_links WHERE issuer = ? AND subject = ?)`;
const LINK_ID = "SELECT link_id FROM oidc_links WHERE issuer = ? AND subject = ?";
const SUBJECT_LINKED = "SELECT identity_name FROM oidc_links WHERE issuer = ? AND subject = ?";
const ISSUE_LINKED = `INSERT INTO login_credentials (hash, identity_name, host, created_at)
  SELECT ?, i.name, ?, ? FROM oidc_links AS l JOIN identities AS i ON i.name = l.identity_name
  WHERE l.issuer = ? AND l.subject = ?
    AND l.identity_name = ? AND l.link_id = ?
    AND i.kind = 'human' AND i.deactivated = FALSE`;
const CREDENTIAL_IDENTITY = `SELECT ${IDENTITY_COLUMNS} FROM identities
  WHERE name = (SELECT identity_name FROM login_credentials WHERE hash = ?)`;
const NAME_TAKEN = "SELECT name FROM identities WHERE name = ?";
const INSERT_LINK = `INSERT INTO oidc_links (issuer, subject, identity_name, link_id, created_at, email)
  VALUES (?, ?, ?, ?, ?, ?)`;
const REFRESH_LINK = "UPDATE oidc_links SET email = ? WHERE issuer = ? AND subject = ?";
const LINK_OF = "SELECT email, created_at FROM oidc_links WHERE issuer = ? AND identity_name = ?";
const INSERT_HUMAN = `INSERT INTO identities (name, kind, owner, admin, created_at, display_name, brought_in_by)
  VALUES (?, 'human', NULL, FALSE, ?, ?, NULL)`;
const INSERT_TOKEN = "INSERT INTO tokens (token_hash, identity_name, revoked) VALUES (?, ?, FALSE)";

const LinkRow = Schema.Struct({ created_at: IsoTimeSchema, email: Schema.String });

const LinkIdRow = Schema.Struct({ link_id: Schema.String.pipe(Schema.refine(isOidcLinkId)) });

function exists(db: SqlDatabase, sql: string, ...params: readonly string[]): Fails<boolean> {
  return Effect.map(db.get(sql, ...params), Predicate.isObject);
}

function sqlCreatedRefusal(db: SqlDatabase, created: NewLinkedHuman): Fails<Option.Option<LinkedHumanResult>> {
  return Effect.gen(function* checkCreate() {
    if (yield* exists(db, SUBJECT_LINKED, created.issuer, created.subject)) {
      return Option.some("subject_taken" as const);
    }
    const taken = yield* exists(db, NAME_TAKEN, created.human.name);
    return Option.liftPredicate("name_taken" as const, () => taken);
  });
}

function decodedIdentity(row: unknown): Fails<Identity | undefined> {
  if (!Predicate.isObject(row)) {
    return Effect.undefined;
  }
  return Schema.decodeUnknownEffect(IdentityRow)(row).pipe(
    Effect.mapBoth({ onFailure: unreadable, onSuccess: toIdentity }),
  );
}

function shownLink(row: unknown): Fails<ShownLink | undefined> {
  if (!Predicate.isObject(row)) {
    return Effect.undefined;
  }
  return Schema.decodeUnknownEffect(LinkRow)(row).pipe(
    Effect.mapBoth({
      onFailure: unreadable,
      onSuccess: (found) => ({ email: found.email, linkedAt: found.created_at }),
    }),
  );
}

function refusedSession({ identity, linked }: RefusedSession): LinkedSession {
  if (Predicate.isNotUndefined(linked) && linked.name === identity && Predicate.isNotUndefined(linked.deactivated)) {
    return { status: "deactivated" };
  }
  return { status: "changed" };
}

function sqlFoundLink(db: SqlDatabase, { issuer, subject }: OidcSubject): Fails<FoundLink | undefined> {
  return db.transaction(
    Effect.gen(function* findLinked() {
      const identity = yield* Effect.flatMap(db.get(FIND_LINKED, issuer, subject), decodedIdentity);
      const row = yield* db.get(LINK_ID, issuer, subject);
      if (Predicate.isUndefined(identity) || !Predicate.isObject(row)) {
        return yield* Effect.undefined;
      }
      const { link_id: linkId } = yield* Schema.decodeUnknownEffect(LinkIdRow)(row).pipe(Effect.mapError(unreadable));
      return { identity, linkId };
    }),
  );
}

function sqlIssued(db: SqlDatabase, issued: LinkedCredential): Fails<LinkedSession> {
  return Effect.gen(function* issueLinked() {
    const { credentialHash, email, host, identity, issuer, linkId, now, subject } = issued;
    yield* db.run(ISSUE_LINKED, credentialHash, host, now, issuer, subject, identity, linkId);
    const holder = yield* Effect.flatMap(db.get(CREDENTIAL_IDENTITY, credentialHash), decodedIdentity);
    if (Predicate.isUndefined(holder)) {
      const linked = yield* Effect.flatMap(db.get(FIND_LINKED, issuer, subject), decodedIdentity);
      return refusedSession({ identity, linked });
    }
    yield* db.run(REFRESH_LINK, email, issuer, subject);
    return { identity: holder, status: "issued" as const };
  });
}

function sqlOidcLinks(db: SqlDatabase): OidcLinksSection {
  return {
    createLinkedHuman: (created) =>
      db.transaction(
        Effect.gen(function* createLinked() {
          const refusal = yield* sqlCreatedRefusal(db, created);
          if (Option.isSome(refusal)) {
            return refusal.value;
          }
          const { human } = created;
          yield* db.run(INSERT_HUMAN, human.name, human.createdAt, human.displayName ?? null);
          yield* db.run(INSERT_TOKEN, created.hash, human.name);
          const { email, issuer, linkId, subject } = created;
          yield* db.run(INSERT_LINK, issuer, subject, human.name, linkId, human.createdAt, email);
          return "created" as const;
        }),
      ),
    findOidcLink: (subject) => sqlFoundLink(db, subject),
    findOidcLinkOf: ({ identity, issuer }) => Effect.flatMap(db.get(LINK_OF, issuer, identity), shownLink),
    issueLinkedLoginCredential: (issued) => db.transaction(sqlIssued(db, issued)),
  };
}

export {
  type FoundLink,
  refusedSession,
  type LinkedCredential,
  type LinkedHumanResult,
  type LinkedSession,
  type NewLinkedHuman,
  OIDC_LINKS_MIGRATION,
  type OidcLinksSection,
  type OidcSubject,
  POSTGRES_OIDC_LINKS_MIGRATION,
  sqlOidcLinks,
};
