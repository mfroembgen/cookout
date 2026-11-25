import { Array as Arr, DateTime, Effect, Function, Option, Predicate, Schema } from "effect";
import type { JWTPayload, createLocalJWKSet } from "jose";
import type { OidcSettings } from "../oidc/settings.ts";
import type { SignInRefusal } from "../oidc/refusals.ts";
import { idTokenInvalid } from "../oidc/refusals.ts";
import { jwtVerify } from "jose";

interface Names {
  readonly name: Option.Option<string>;
  readonly givenName: Option.Option<string>;
  readonly familyName: Option.Option<string>;
}

interface VerifiedIdToken {
  readonly subject: string;
  readonly names: Names;
}

interface IdTokenCheck {
  readonly idToken: Option.Option<string>;
  readonly nonce: string;
  readonly jwksUri: string;
  readonly settings: OidcSettings;
}

type KeySet = ReturnType<typeof createLocalJWKSet>;

interface Rejected {
  readonly reason: string;
}

interface KeySource {
  readonly cached: (check: IdTokenCheck) => Effect.Effect<KeySet, SignInRefusal>;
  readonly fetched: (check: IdTokenCheck) => Effect.Effect<KeySet, SignInRefusal>;
}

const MAX_TOKEN_AGE_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const ALGORITHMS = ["RS256", "ES256"];
const REQUIRED_CLAIMS = ["exp", "iat", "sub"];
const UNVERIFIED = "unverified";
const UNKNOWN_KEY = "ERR_JWKS_NO_MATCHING_KEY";
const ONE_AUDIENCE = 1;

const JwksSchema = Schema.Struct({ keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) });

const IdClaimsSchema = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  azp: Schema.optionalKey(Schema.String),
  family_name: Schema.optionalKey(Schema.Unknown),
  given_name: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  nonce: Schema.String,
  sub: Schema.NonEmptyString,
});

type IdClaims = typeof IdClaimsSchema.Type;

const CodedSchema = Schema.Struct({ code: Schema.String });

function textOf(value: unknown): Option.Option<string> {
  return Option.liftPredicate(value, Predicate.isString);
}

function reasonOf(failure: unknown): string {
  const coded = Schema.decodeUnknownOption(CodedSchema)(failure);
  return Option.getOrElse(
    Option.map(coded, ({ code }) => code),
    Function.constant(UNVERIFIED),
  );
}

function isForThisSignIn(claims: IdClaims, { nonce, settings }: IdTokenCheck): boolean {
  const audiences = Arr.ensure(claims.aud);
  const onlyThisClient =
    audiences.length === ONE_AUDIENCE && Arr.every(audiences, (audience) => audience === settings.client);
  const party = Predicate.isUndefined(claims.azp) || claims.azp === settings.client;
  return claims.nonce === nonce && onlyThisClient && party;
}

function namesIn(claims: IdClaims): Names {
  return {
    familyName: textOf(claims.family_name),
    givenName: textOf(claims.given_name),
    name: textOf(claims.name),
  };
}

function isUnknownKey(failure: Rejected | SignInRefusal): boolean {
  return Predicate.hasProperty(failure, "reason") && failure.reason === UNKNOWN_KEY;
}

function refusalOf(failure: Rejected | SignInRefusal): SignInRefusal {
  if (Predicate.hasProperty(failure, "reason")) {
    return idTokenInvalid(failure.reason);
  }
  return failure;
}

function signedPayload(
  check: IdTokenCheck,
): (keySet: Effect.Effect<KeySet, SignInRefusal>) => Effect.Effect<JWTPayload, Rejected | SignInRefusal> {
  return (keySet) =>
    Effect.gen(function* verifySignature() {
      const keys = yield* keySet;
      const now = yield* DateTime.now;
      const options = {
        algorithms: ALGORITHMS,
        audience: check.settings.client,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: DateTime.toDate(now),
        issuer: check.settings.issuer,
        maxTokenAge: MAX_TOKEN_AGE_SECONDS,
        requiredClaims: REQUIRED_CLAIMS,
      };
      const idToken = yield* Effect.mapError(
        Effect.fromOption(check.idToken),
        Function.constant({ reason: "missing" }),
      );
      const { payload } = yield* Effect.tryPromise({
        catch: (failure): Rejected => ({ reason: reasonOf(failure) }),
        try: () => jwtVerify(idToken, keys, options),
      });
      return payload;
    });
}

function verifiedIdTokenWith(
  source: KeySource,
): (check: IdTokenCheck) => Effect.Effect<VerifiedIdToken, SignInRefusal> {
  return (check) =>
    Effect.gen(function* verifyIdToken() {
      const verified = signedPayload(check);
      const payload = yield* verified(source.cached(check)).pipe(
        Effect.catchIf(isUnknownKey, () => verified(source.fetched(check))),
        Effect.mapError(refusalOf),
      );
      const claims = yield* Effect.mapError(Schema.decodeUnknownEffect(IdClaimsSchema)(payload), () =>
        idTokenInvalid("claims"),
      );
      return yield* Effect.filterOrFail(
        Effect.succeed({ names: namesIn(claims), subject: claims.sub }),
        () => isForThisSignIn(claims, check),
        () => idTokenInvalid("nonce, aud or azp"),
      );
    });
}

export { type IdTokenCheck, JwksSchema, type KeySource, type Names, type VerifiedIdToken, textOf, verifiedIdTokenWith };
