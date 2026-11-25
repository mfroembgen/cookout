import { Array as Arr, DateTime, Effect, Layer, Option, Record as Rec, Schema, String as Str } from "effect";
import type { FakeProviderOptions, FakeState, FakeUser, Grant, IdTokenChanges } from "./state.ts";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { nodeHttpServer, serverUrl } from "../../../http/server.ts";
import type { Scope } from "effect";
import type { Secrets } from "../../../secrets/server.ts";
import type { Signer } from "./keys.ts";
import { fakeKeys } from "./keys.ts";
import { fakeState } from "./state.ts";

interface FakeProvider {
  readonly issuer: string;
  readonly announce: (fields: Readonly<Record<string, string>>) => Effect.Effect<void>;
  readonly nextIdToken: (changes: IdTokenChanges) => Effect.Effect<void>;
  readonly refuseNext: (error: string) => Effect.Effect<void>;
  readonly sendIssuer: (issuer: string) => Effect.Effect<void>;
  readonly signInAs: (user: FakeUser) => Effect.Effect<void>;
}

interface Asked {
  readonly authorization: string;
  readonly query: Query;
  readonly route: string;
}

type Answer = HttpServerResponse.HttpServerResponse;

type Query = Readonly<Record<string, string>>;

type Handler = (state: FakeState, asked: Asked) => Effect.Effect<Answer, never, HttpServerRequest.HttpServerRequest>;

const LISTEN = { host: "127.0.0.1", port: 0 } as const;
const MILLIS = 1000;
const ID_TOKEN_SECONDS = 300;
const EXPIRED_BY_SECONDS = 3600;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const VERIFIER = /^[\w.~-]{43,128}$/u;
const TOKEN_SCHEME = "Bearer ";
const PATH_BASE = "http://oidc-fake.invalid";
const AUTHORIZATION_FIELDS = ["redirect_uri", "state", "code_challenge", "nonce"] as const;

const TokenRequestSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  code: Schema.String,
  code_verifier: Schema.String,
  grant_type: Schema.Literal("authorization_code"),
  redirect_uri: Schema.String,
});

type TokenRequest = typeof TokenRequestSchema.Type;

function refused(error: string, status = BAD_REQUEST): Answer {
  return HttpServerResponse.jsonUnsafe({ error }, { status });
}

function discovery(state: FakeState): Effect.Effect<Answer> {
  return Effect.gen(function* discoveryDocument() {
    const issuer = yield* state.issuer;
    const announced = yield* state.announced;
    return HttpServerResponse.jsonUnsafe({
      authorization_endpoint: `${issuer}/authorize`,
      code_challenge_methods_supported: ["S256"],
      issuer,
      jwks_uri: `${issuer}/jwks`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      ...announced,
    });
  });
}

function isPkceCode(query: Query): boolean {
  const everyField = Arr.every(AUTHORIZATION_FIELDS, (field) => Str.isNonEmpty(query[field] ?? ""));
  return everyField && query["response_type"] === "code" && query["code_challenge_method"] === "S256";
}

function isAuthorizationRequest(query: Query, options: FakeProviderOptions): boolean {
  return isPkceCode(query) && query["client_id"] === options.client && Str.includes("openid")(query["scope"] ?? "");
}

function backTo(redirectUri: string, params: Query): Answer {
  const url = new URL(redirectUri);
  for (const [name, value] of Rec.toEntries(params)) {
    url.searchParams.set(name, value);
  }
  return HttpServerResponse.redirect(url.href);
}

function grantOf(query: Query, user: FakeUser): Grant {
  const { code_challenge: challenge = "", nonce = "", redirect_uri: redirectUri = "" } = query;
  return { challenge, nonce, redirectUri, user };
}

function returnedWith(state: FakeState, query: Query): Effect.Effect<Query> {
  return Effect.gen(function* codeOrError() {
    const issuer = yield* state.issuer;
    const sentIssuer = yield* state.sentIssuer;
    const back = { iss: Option.getOrElse(sentIssuer, () => issuer), state: query["state"] ?? "" };
    const refusal = yield* state.takeRefusal;
    if (Option.isSome(refusal)) {
      return { ...back, error: refusal.value };
    }
    const code = yield* state.counted("code");
    const user = yield* state.user;
    yield* state.grant(code, grantOf(query, user));
    return { ...back, code };
  });
}

function authorize(state: FakeState, { query }: Asked): Effect.Effect<Answer> {
  if (!isAuthorizationRequest(query, state.options)) {
    return Effect.succeed(refused("invalid_request"));
  }
  return Effect.map(returnedWith(state, query), (params) => backTo(query["redirect_uri"] ?? "", params));
}

function isClient(options: FakeProviderOptions, sent: TokenRequest): boolean {
  const secretMatches = Option.match(options.clientSecret, {
    onNone: () => true,
    onSome: (secret) => sent.client_secret === secret,
  });
  return secretMatches && sent.client_id === options.client;
}

function grantFor(state: FakeState, sent: TokenRequest): Effect.Effect<Option.Option<Grant>> {
  return Effect.gen(function* checkGrant() {
    const grant = yield* state.takeGrant(sent.code);
    const challenge = yield* state.challengeOf(sent.code_verifier);
    return Option.filter(
      grant,
      (found) =>
        isClient(state.options, sent) &&
        sent.redirect_uri === found.redirectUri &&
        VERIFIER.test(sent.code_verifier) &&
        challenge === found.challenge,
    );
  });
}

function signerOf({ otherKey, rekeyed, rotated }: IdTokenChanges): Signer {
  if (rotated === true) {
    return "rotated";
  }
  if (rekeyed === true) {
    return "rekeyed";
  }
  if (otherKey === true) {
    return "unpublished";
  }
  return "published";
}

function subjectOf({ email, subject }: FakeUser): string {
  return subject ?? `fake|${email}`;
}

function idTokenFor(state: FakeState, grant: Grant): Effect.Effect<Readonly<Record<string, string>>> {
  return Effect.gen(function* idToken() {
    const issuer = yield* state.issuer;
    const changes = yield* state.takeIdTokenChanges;
    if (changes.omit === true) {
      return {};
    }
    const clock = yield* DateTime.now;
    const issuedAt =
      Math.floor(DateTime.toEpochMillis(clock) / MILLIS) - Number(changes.expired === true) * EXPIRED_BY_SECONDS;
    const claims = {
      aud: state.options.client,
      exp: issuedAt + ID_TOKEN_SECONDS,
      iat: issuedAt,
      iss: issuer,
      nonce: grant.nonce,
      sub: subjectOf(grant.user),
      ...changes.claims,
    };
    const kept = Rec.filter(claims, (_value, name) => !(changes.without ?? []).includes(name));
    const signed = yield* state.keys.signed(kept, signerOf(changes));
    return { id_token: signed };
  });
}

function token(state: FakeState): Effect.Effect<Answer, never, HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* exchangeCode() {
    const sent = yield* HttpServerRequest.schemaBodyUrlParams(TokenRequestSchema);
    const grant = yield* grantFor(state, sent);
    if (Option.isNone(grant)) {
      return refused("invalid_grant");
    }
    const issued = yield* state.counted("token");
    yield* state.holdToken(issued, grant.value.user);
    const idToken = yield* idTokenFor(state, grant.value);
    return HttpServerResponse.jsonUnsafe({ access_token: issued, expires_in: 3600, ...idToken, token_type: "Bearer" });
  }).pipe(Effect.orElseSucceed(() => refused("invalid_request")));
}

function userinfo(state: FakeState, { authorization }: Asked): Effect.Effect<Answer> {
  return Effect.map(state.userOf(Str.slice(TOKEN_SCHEME.length)(authorization)), (user) =>
    Option.match(user, {
      onNone: () => refused("invalid_token", UNAUTHORIZED),
      onSome: (found) =>
        HttpServerResponse.jsonUnsafe({
          email: found.email,
          email_verified: found.emailVerified,
          family_name: found.familyName,
          given_name: found.givenName,
          name: found.name,
          sub: subjectOf(found),
        }),
    }),
  );
}

const handlers: Readonly<Record<string, Handler>> = {
  "GET /.well-known/openid-configuration": discovery,
  "GET /authorize": authorize,
  "GET /jwks": (state) => Effect.map(state.keys.jwks, (jwks) => HttpServerResponse.jsonUnsafe(jwks)),
  "GET /userinfo": userinfo,
  "POST /token": token,
};

function answering(state: FakeState): Effect.Effect<Answer, never, HttpServerRequest.HttpServerRequest> {
  return Effect.flatMap(HttpServerRequest.HttpServerRequest, ({ headers, method, url }) => {
    const { pathname, searchParams } = new URL(url, PATH_BASE);
    const asked = {
      authorization: headers["authorization"] ?? "",
      query: Rec.fromEntries(searchParams),
      route: `${method} ${pathname}`,
    };
    return Option.match(Rec.get(handlers, asked.route), {
      onNone: () => Effect.succeed(refused("not_found", NOT_FOUND)),
      onSome: (handler) => handler(state, asked),
    });
  });
}

function fakeProvider(options: FakeProviderOptions): Effect.Effect<FakeProvider, never, Scope.Scope | Secrets> {
  return Effect.gen(function* startFakeProvider() {
    const keys = yield* fakeKeys;
    const state = yield* fakeState({ keys, options });
    const serving = HttpServer.serve(answering(state)).pipe(Layer.provideMerge(nodeHttpServer(LISTEN)));
    const server = yield* Layer.build(serving);
    const url = yield* Effect.provideContext(serverUrl, server);
    yield* state.setIssuer(url);
    const provider: FakeProvider = {
      announce: state.announce,
      issuer: url,
      nextIdToken: state.nextIdToken,
      refuseNext: state.refuseNext,
      sendIssuer: state.sendIssuer,
      signInAs: state.signInAs,
    };
    return provider;
  }).pipe(Effect.orDie);
}

export { fakeProvider };
