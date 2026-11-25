import { Array as Arr, DateTime, Effect, Function, Option, String as Str } from "effect";
import type { DisplayName, HumanIdentity, Identity, IdentityName, Token } from "../../../index.ts";
import type { FoundLink, StorageUnavailable } from "../../../../storage/server.ts";
import type { Names, UserInfo } from "../routes/oidc-provider.ts";
import { deactivated, emailNotAllowed, emailUnverified, nameTaken, nameUnusable, signInChanged } from "./refusals.ts";
import { isDisplayName, isOwner } from "../../../index.ts";
import { IdentityChanges } from "../changes.ts";
import { Secrets } from "../../../../secrets/server.ts";
import type { SignInRefusal } from "./refusals.ts";
import { Storage } from "../../../../storage/server.ts";
import { isOidcLinkId } from "../../../../oidc/index.ts";
import { isoTimeOf } from "../../../../time/server.ts";

interface EmailCheck {
  readonly domain: string;
  readonly info: UserInfo;
}

interface Returning {
  readonly domain: string;
  readonly info: UserInfo;
  readonly idTokenNames: Names;
  readonly subject: { readonly issuer: string; readonly subject: string };
}

interface Verified {
  readonly email: string;
  readonly local: string;
}

interface Person {
  readonly name: IdentityName;
  readonly displayName: Option.Option<DisplayName>;
}

type SignInNeeds = Storage | Secrets | IdentityChanges;

interface SignedIn {
  readonly identity: Identity;
  readonly token: Token;
}

const SIGN_IN_HOST = "web UI (single sign-on)";

const AT = "@";
const START = 0;
const SEPARATORS = /[._]/gu;

function localPartAt(email: string, domain: string): Option.Option<string> {
  return Option.flatMap(Str.lastIndexOf(AT)(email), (at) =>
    Option.liftPredicate(Str.slice(START, at)(email), () => Str.slice(at + AT.length)(email) === domain),
  );
}

function verifiedEmail({ domain, info }: EmailCheck): Effect.Effect<Verified, SignInRefusal> {
  if (!info.emailVerified) {
    return Effect.fail(emailUnverified);
  }
  const email = Str.toLowerCase(Option.getOrElse(info.email, Function.constant("")));
  return Effect.fromOption(localPartAt(email, domain)).pipe(
    Effect.mapBoth({ onFailure: () => emailNotAllowed(domain), onSuccess: (local) => ({ email, local }) }),
  );
}

function nameOf(local: string): Effect.Effect<IdentityName, SignInRefusal> {
  const name = Str.replaceAll(SEPARATORS, "-")(local);
  if (isOwner(name)) {
    return Effect.succeed(name);
  }
  return Effect.fail(nameUnusable(local));
}

function spoken(text: string): Option.Option<string> {
  return Option.liftPredicate(Str.trim(text), Str.isNonEmpty);
}

function displayNameOf(names: Names): Option.Option<DisplayName> {
  const parts = Arr.getSomes([Option.flatMap(names.givenName, spoken), Option.flatMap(names.familyName, spoken)]);
  return Option.flatMap(names.name, spoken).pipe(
    Option.orElse(() => spoken(Arr.join(parts, " "))),
    Option.filter(isDisplayName),
  );
}

function personNamed(local: string, returning: Returning): Effect.Effect<Person, SignInRefusal> {
  const displayName = Arr.findFirst([returning.idTokenNames, returning.info], displayNameOf);
  return Effect.map(nameOf(local), (name) => ({ displayName, name }));
}

function newHuman(person: Person): Effect.Effect<HumanIdentity> {
  return Effect.map(DateTime.now, (now) => {
    const human: HumanIdentity = { admin: false, createdAt: isoTimeOf(now), kind: "human", name: person.name };
    return Option.match(person.displayName, {
      onNone: () => human,
      onSome: (displayName) => ({ ...human, displayName }),
    });
  });
}

function winningLink(
  returning: Returning,
  verified: Verified,
): Effect.Effect<FoundLink, SignInRefusal | StorageUnavailable, Storage> {
  return Effect.flatMap(Storage, (storage) =>
    Effect.flatMap(storage.findOidcLink(returning.subject), (held) =>
      Effect.mapError(Effect.fromNullishOr(held), () => signInChanged(verified.email)),
    ),
  );
}

function createdOrFound(
  returning: Returning,
  verified: Verified,
): Effect.Effect<FoundLink, SignInRefusal | StorageUnavailable, SignInNeeds> {
  return Effect.gen(function* createLinkedHuman() {
    const person = yield* personNamed(verified.local, returning);
    const human = yield* newHuman(person);
    const secrets = yield* Secrets;
    const hash = yield* Effect.flatMap(secrets.newToken, secrets.hashToken);
    const linkSecret = yield* Effect.flatMap(secrets.newToken, secrets.digest);
    const linkId = Option.getOrThrow(Option.liftPredicate(linkSecret, isOidcLinkId));
    const storage = yield* Storage;
    const result = yield* storage.createLinkedHuman({
      ...returning.subject,
      email: verified.email,
      hash,
      human,
      linkId,
    });
    const outcomes: Readonly<
      Record<typeof result, Effect.Effect<FoundLink, SignInRefusal | StorageUnavailable, SignInNeeds>>
    > = {
      created: Effect.as(
        Effect.flatMap(IdentityChanges, (changes) => changes.publish(human)),
        { identity: human, linkId },
      ),
      name_taken: Effect.fail(nameTaken(human.name)),
      subject_taken: winningLink(returning, verified),
    };
    return yield* outcomes[result];
  });
}

function sessionOf(
  { identity, linkId }: FoundLink,
  signedIn: Returning["subject"] & { readonly email: string },
): Effect.Effect<SignedIn, SignInRefusal | StorageUnavailable, Storage | Secrets> {
  return Effect.gen(function* issueLinkedSession() {
    const secrets = yield* Secrets;
    const storage = yield* Storage;
    const token = yield* secrets.newToken;
    const credentialHash = yield* secrets.hashToken(token);
    const now = yield* DateTime.now;
    const issued = yield* storage.issueLinkedLoginCredential({
      ...signedIn,
      credentialHash,
      host: SIGN_IN_HOST,
      identity: identity.name,
      linkId,
      now: isoTimeOf(now),
    });
    const refusals = { changed: signInChanged(identity.name), deactivated: deactivated(identity.name) };
    if (issued.status !== "issued") {
      return yield* Effect.fail(refusals[issued.status]);
    }
    return { identity: issued.identity, token };
  });
}

function signedInHuman(returning: Returning): Effect.Effect<SignedIn, SignInRefusal | StorageUnavailable, SignInNeeds> {
  return Effect.gen(function* findLinkOrMakeIt() {
    const verified = yield* verifiedEmail({ domain: returning.domain, info: returning.info });
    const storage = yield* Storage;
    const linked = yield* storage.findOidcLink(returning.subject);
    const found = yield* Option.match(Option.fromUndefinedOr(linked), {
      onNone: () => createdOrFound(returning, verified),
      onSome: Effect.succeed,
    });
    return yield* sessionOf(found, { ...returning.subject, email: verified.email });
  });
}

export { type SignInNeeds, signedInHuman };
