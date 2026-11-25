import { Effect, Option, Predicate, Struct } from "effect";
import type {
  FoundLink,
  LinkedCredential,
  LinkedHumanResult,
  LinkedSession,
  NewLinkedHuman,
  OidcLinksSection,
  OidcSubject,
} from "./oidc-links.ts";
import type { Identity, IdentityName, TokenHash } from "../../../identities/index.ts";
import type { CreateRefusal } from "./identity-owners.ts";
import type { Fails } from "./errors.ts";
import type { FindIdentity } from "./identity-row.ts";
import type { IsoTime } from "../../../time/index.ts";
import type { IssueLoginCredential } from "./login-requests.ts";
import type { MemoryState } from "./memory-state.ts";
import type { OidcLinkId } from "../../../oidc/index.ts";
import { refusedSession } from "./oidc-links.ts";

interface MemoryOidcLinksOptions {
  readonly state: MemoryState;
  readonly issueCredentialNow: (given: IssueLoginCredential) => Identity | undefined;
  readonly findIdentity: FindIdentity;
  readonly createNow: (identity: Identity, hash: TokenHash) => "created" | CreateRefusal;
}

type MemoryOidcLinksSection = OidcLinksSection & {
  readonly dropOidcLinks: (name: IdentityName) => Effect.Effect<void>;
};

interface HeldLink {
  readonly issuer: string;
  readonly name: IdentityName;
  readonly email: string;
  readonly linkedAt: IsoTime;
  readonly linkId: OidcLinkId;
}

interface MemoryLinks {
  readonly links: Map<string, HeldLink>;
  readonly linked: Map<string, string>;
}

const SEPARATOR = "\n";

function keyOf(issuer: string, part: string): string {
  return `${issuer}${SEPARATOR}${part}`;
}

function isActiveHuman(found: Identity | undefined): boolean {
  return Predicate.isNotUndefined(found) && found.kind === "human" && Predicate.isUndefined(found.deactivated);
}

interface Issuing {
  readonly findIdentity: FindIdentity;
  readonly issueCredentialNow: MemoryOidcLinksOptions["issueCredentialNow"];
}

function refreshIn(held: MemoryLinks, { email, issuer, subject }: OidcSubject & { readonly email: string }): void {
  const key = keyOf(issuer, subject);
  Option.map(Option.fromUndefinedOr(held.links.get(key)), (link) => held.links.set(key, { ...link, email }));
}

function foundLinkIn(held: MemoryLinks, findIdentity: FindIdentity, subject: OidcSubject): Option.Option<FoundLink> {
  const link = Option.fromUndefinedOr(held.links.get(keyOf(subject.issuer, subject.subject)));
  return Option.flatMap(link, ({ linkId, name }) =>
    Option.map(Option.fromUndefinedOr(findIdentity(name)), (identity) => ({ identity, linkId })),
  );
}

function issueLinkedIn(held: MemoryLinks, issuing: Issuing): (issued: LinkedCredential) => LinkedSession {
  return (signedIn) => {
    const { credentialHash, host, identity, issuer, linkId, now, subject } = signedIn;
    const linked = foundLinkIn(held, issuing.findIdentity, { issuer, subject });
    const allowed = Option.filter(
      linked,
      (found) => found.identity.name === identity && found.linkId === linkId && isActiveHuman(found.identity),
    );
    const issued = Option.flatMap(allowed, () =>
      Option.fromUndefinedOr(issuing.issueCredentialNow({ credentialHash, host, identity, now })),
    );
    if (Option.isNone(issued)) {
      const linkedIdentity = Option.map(linked, Struct.get("identity"));
      return refusedSession({ identity, linked: Option.getOrUndefined(linkedIdentity) });
    }
    refreshIn(held, signedIn);
    return { identity: issued.value, status: "issued" };
  };
}

function holdIn(held: MemoryLinks, subject: OidcSubject, link: Omit<HeldLink, "issuer">): void {
  const key = keyOf(subject.issuer, subject.subject);
  held.links.set(key, { ...link, issuer: subject.issuer });
  held.linked.set(keyOf(subject.issuer, link.name), key);
}

function dropIn(held: MemoryLinks, name: IdentityName): void {
  for (const [key, link] of held.links) {
    if (link.name === name) {
      held.links.delete(key);
      held.linked.delete(keyOf(link.issuer, name));
    }
  }
}

interface Creating {
  readonly created: NewLinkedHuman;
  readonly createNow: MemoryOidcLinksOptions["createNow"];
}

function createIn(held: MemoryLinks, { created, createNow }: Creating): LinkedHumanResult {
  if (held.links.has(keyOf(created.issuer, created.subject))) {
    return "subject_taken";
  }
  if (createNow(created.human, created.hash) !== "created") {
    return "name_taken";
  }
  const { email, human, linkId } = created;
  holdIn(held, created, { email, linkId, linkedAt: human.createdAt, name: human.name });
  return "created";
}

function whileOpen(state: MemoryState): <Value>(work: () => Value) => Fails<Value> {
  return (work) => Effect.andThen(state.ensureOpen, Effect.sync(work));
}

function memoryOidcLinks({
  createNow,
  findIdentity,
  issueCredentialNow,
  state,
}: MemoryOidcLinksOptions): MemoryOidcLinksSection {
  const held: MemoryLinks = { linked: new Map(), links: new Map() };
  const open = whileOpen(state);
  const issueLinked = issueLinkedIn(held, { findIdentity, issueCredentialNow });
  return {
    createLinkedHuman: (created) => open(() => createIn(held, { createNow, created })),
    dropOidcLinks: (name) =>
      Effect.sync(() => {
        dropIn(held, name);
      }),
    findOidcLink: (subject) => open(() => Option.getOrUndefined(foundLinkIn(held, findIdentity, subject))),
    findOidcLinkOf: ({ identity, issuer }) =>
      open(() =>
        Option.fromUndefinedOr(held.linked.get(keyOf(issuer, identity))).pipe(
          Option.flatMap((key) => Option.fromUndefinedOr(held.links.get(key))),
          Option.map(({ email, linkedAt }) => ({ email, linkedAt })),
          Option.getOrUndefined,
        ),
      ),
    issueLinkedLoginCredential: (issued) => open(() => issueLinked(issued)),
  };
}

export { memoryOidcLinks };
