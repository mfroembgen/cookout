import { Effect, Layer, Option, Predicate, Record as Rec, String as Str } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { OidcFake, oidcFake } from "../../server.ts";
import { Secrets, secretsLive } from "../../../secrets/server.ts";
import { expect, it } from "@effect/vitest";

interface Answered {
  readonly status: number;
  readonly json: unknown;
  readonly location: string;
}

type Needs = HttpClient.HttpClient | OidcFake | Secrets;

const OK = 200;
const FOUND = 302;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const VERIFIER = "a-verifier-of-forty-three-characters-or-more-0123456789";
const REDIRECT_URI = "https://board.example.com/v1/oidc/callback";
const ADA = { email: "ada@example.com", emailVerified: true, name: "Ada Lovelace" };

const neverRedirected = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
);

function fieldIn(json: unknown, field: string): string {
  if (Predicate.hasProperty(json, field) && typeof json[field] === "string") {
    return json[field];
  }
  return "";
}

function paramsOf(location: string): Readonly<Record<string, string>> {
  return Rec.fromEntries(new URL(location).searchParams);
}

function sent(request: HttpClientRequest.HttpClientRequest): Effect.Effect<Answered, never, HttpClient.HttpClient> {
  return Effect.gen(function* sendRequest() {
    const response = yield* HttpClient.execute(request);
    const json = yield* Effect.orElseSucceed(response.json, () => null);
    return { json, location: response.headers["location"] ?? "", status: response.status };
  }).pipe(Effect.orDie);
}

const challenge = Effect.flatMap(Secrets, (secrets) =>
  Effect.map(secrets.digest(VERIFIER), (hex) => Buffer.from(hex, "hex").toString("base64url")),
);

function authorized(changed: Readonly<Record<string, string>> = {}): Effect.Effect<Answered, never, Needs> {
  return Effect.gen(function* askToAuthorize() {
    const fake = yield* OidcFake;
    const codeChallenge = yield* challenge;
    const params = {
      client_id: fake.client,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      nonce: "nonce-1",
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
      state: "state-1",
    };
    return yield* sent(HttpClientRequest.get(`${fake.issuer}/authorize`, { urlParams: { ...params, ...changed } }));
  });
}

function exchanged(form: Readonly<Record<string, string>>): Effect.Effect<Answered, never, Needs> {
  return Effect.gen(function* exchangeCode() {
    const fake = yield* OidcFake;
    const request = HttpClientRequest.post(`${fake.issuer}/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: fake.client,
        code_verifier: VERIFIER,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        ...form,
      }),
    );
    return yield* sent(request);
  });
}

function userinfoWith(accessToken: string): Effect.Effect<Answered, never, Needs> {
  return Effect.flatMap(OidcFake, (fake) =>
    sent(
      HttpClientRequest.get(`${fake.issuer}/userinfo`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
      ),
    ),
  );
}

const adaCode = Effect.gen(function* authorizeAda() {
  const fake = yield* OidcFake;
  yield* fake.signInAs(ADA);
  const back = yield* authorized();
  return Option.getOrElse(Rec.get(paramsOf(back.location), "code"), () => "");
});

it.effect("the fake provider's discovery document names its issuer and endpoints, or another issuer", () =>
  Effect.gen(function* readsDiscovery() {
    const fake = yield* OidcFake;
    const document = HttpClientRequest.get(`${fake.issuer}/.well-known/openid-configuration`);
    const discovery = yield* sent(document);
    yield* fake.announce({ issuer: "https://other.example.com" });
    const announced = yield* sent(document);

    expect(discovery).toMatchObject({
      json: {
        authorization_endpoint: `${fake.issuer}/authorize`,
        issuer: fake.issuer,
        jwks_uri: `${fake.issuer}/jwks`,
        token_endpoint: `${fake.issuer}/token`,
        userinfo_endpoint: `${fake.issuer}/userinfo`,
      },
      status: OK,
    });
    expect(announced.json).toMatchObject({ issuer: "https://other.example.com" });
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider sends the browser back with a code, the state and its issuer", () =>
  Effect.gen(function* sendsBack() {
    const fake = yield* OidcFake;
    const back = yield* authorized();

    expect([back.status, Str.startsWith(`${REDIRECT_URI}?`)(back.location)]).toStrictEqual([FOUND, true]);
    expect(paramsOf(back.location)).toStrictEqual({ code: "code-1", iss: fake.issuer, state: "state-1" });
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider refuses an authorization request that isn't PKCE S256, or has no state", () =>
  Effect.gen(function* refusesPlain() {
    const plain = yield* authorized({ code_challenge_method: "plain" });
    const stateless = yield* authorized({ state: "" });

    expect([plain, stateless]).toMatchObject([
      { json: { error: "invalid_request" }, status: BAD_REQUEST },
      { json: { error: "invalid_request" }, status: BAD_REQUEST },
    ]);
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider sends the next authorization back with the error and issuer it was told to", () =>
  Effect.gen(function* sendsError() {
    const fake = yield* OidcFake;
    yield* fake.refuseNext("access_denied");
    yield* fake.sendIssuer("https://other.example.com");
    const back = yield* authorized();

    expect(paramsOf(back.location)).toStrictEqual({
      error: "access_denied",
      iss: "https://other.example.com",
      state: "state-1",
    });
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("a code from the fake provider is good once, for the user's claims at the userinfo endpoint", () =>
  Effect.gen(function* exchangesOnce() {
    const code = yield* adaCode;
    const first = yield* exchanged({ code });
    const again = yield* exchanged({ code });
    const claims = yield* userinfoWith(fieldIn(first.json, "access_token"));

    expect([first.status, again]).toMatchObject([OK, { json: { error: "invalid_grant" }, status: BAD_REQUEST }]);
    expect(fieldIn(first.json, "id_token")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/u);
    expect(claims.json).toStrictEqual({
      email: "ada@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      sub: "fake|ada@example.com",
    });
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider publishes its signing key, and leaves out the next ID token when told to", () =>
  Effect.gen(function* publishesKeys() {
    const fake = yield* OidcFake;
    const jwks = yield* sent(HttpClientRequest.get(`${fake.issuer}/jwks`));
    yield* fake.nextIdToken({ omit: true });
    const code = yield* adaCode;
    const exchange = yield* exchanged({ code });

    expect(jwks.json).toMatchObject({ keys: [{ alg: "RS256", kid: "fake-key-1", kty: "RSA", use: "sig" }] });
    expect(Predicate.hasProperty(exchange.json, "id_token")).toBe(false);
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider refuses a code sent with a verifier whose challenge it wasn't given", () =>
  Effect.gen(function* refusesVerifier() {
    const code = yield* adaCode;
    const refused = yield* exchanged({ code, code_verifier: `${VERIFIER}-other` });

    expect(refused).toMatchObject({ json: { error: "invalid_grant" }, status: BAD_REQUEST });
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);

it.effect("the fake provider with a client secret takes a code only with it", () =>
  Effect.gen(function* refusesWithoutSecret() {
    const first = yield* adaCode;
    const without = yield* exchanged({ code: first });
    const second = yield* adaCode;
    const withIt = yield* exchanged({ client_secret: "fake-secret", code: second });

    expect([without.status, withIt.status]).toStrictEqual([BAD_REQUEST, OK]);
  }).pipe(Effect.provide([oidcFake({ clientSecret: "fake-secret" }), neverRedirected, secretsLive])),
);

it.effect("the fake provider refuses a token request that isn't one, an unknown access token and other paths", () =>
  Effect.gen(function* refusesOthers() {
    const fake = yield* OidcFake;
    const notForm = yield* sent(HttpClientRequest.post(`${fake.issuer}/token`));
    const unknownToken = yield* userinfoWith("token-0");
    const elsewhere = yield* sent(HttpClientRequest.get(`${fake.issuer}/elsewhere`));

    expect([notForm, unknownToken, elsewhere]).toMatchObject([
      { json: { error: "invalid_request" }, status: BAD_REQUEST },
      { json: { error: "invalid_token" }, status: UNAUTHORIZED },
      { json: { error: "not_found" }, status: NOT_FOUND },
    ]);
  }).pipe(Effect.provide([oidcFake(), neverRedirected, secretsLive])),
);
