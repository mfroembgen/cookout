import {
  Array as Arr,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { IdTokenCheck, KeySource, Names, VerifiedIdToken } from "./id-token.ts";
import { JwksSchema, textOf, verifiedIdTokenWith } from "./id-token.ts";
import { isEndpointOf, isLoopbackUrl, redirectUriOf } from "../oidc/settings.ts";
import { isGuardRefusal, providerRequestInitOf } from "../adapters/provider-network.ts";
import type { OidcSettings } from "../oidc/settings.ts";
import type { SignInRefusal } from "../oidc/refusals.ts";
import { createLocalJWKSet } from "jose";
import { providerFailed } from "../oidc/refusals.ts";

interface Provider {
  readonly authorizationEndpoint: string;
  readonly jwksUri: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint: string;
}

interface UserInfo extends Names {
  readonly sub: string;
  readonly email: Option.Option<string>;
  readonly emailVerified: boolean;
}

interface Tokens {
  readonly accessToken: string;
  readonly idToken: Option.Option<string>;
}

interface CodeExchange {
  readonly code: string;
  readonly provider: Provider;
  readonly settings: OidcSettings;
  readonly verifier: string;
}

interface UserInfoRequest {
  readonly accessToken: string;
  readonly provider: Provider;
  readonly settings: OidcSettings;
}

interface Call<Decoded> {
  readonly issuer: string;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly schema: Schema.Decoder<Decoded>;
  readonly step: string;
}

interface OidcProviderService {
  readonly discovered: (settings: OidcSettings) => Effect.Effect<Provider, SignInRefusal>;
  readonly tokens: (exchange: CodeExchange) => Effect.Effect<Tokens, SignInRefusal>;
  readonly verifiedIdToken: (check: IdTokenCheck) => Effect.Effect<VerifiedIdToken, SignInRefusal>;
  readonly userInfo: (asked: UserInfoRequest) => Effect.Effect<UserInfo, SignInRefusal>;
}

class OidcProvider extends Context.Service<OidcProvider, OidcProviderService>()(
  "@ai-hero/cookout/identities/lib/server/routes/oidc-provider/OidcProvider",
) {}

const TIMEOUT_SECONDS = 10;
const KEYS_KEPT_MINUTES = 10;
const KEYS_KEPT = Duration.minutes(KEYS_KEPT_MINUTES);
const NEVER = 0;
const DISCOVERY_PATH = "/.well-known/openid-configuration";
const TOKEN_SCHEME = "Bearer";
const DISCOVERY = "discovery document";
const TRAILING_SLASH = /\/$/u;

const DiscoverySchema = Schema.Struct({
  authorization_endpoint: Schema.String,
  issuer: Schema.String,
  jwks_uri: Schema.String,
  token_endpoint: Schema.String,
  userinfo_endpoint: Schema.String,
});

const TokenSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  id_token: Schema.optionalKey(Schema.NonEmptyString),
});

const UserInfoSchema = Schema.Struct({
  email: Schema.optionalKey(Schema.Unknown),
  email_verified: Schema.optionalKey(Schema.Unknown),
  family_name: Schema.optionalKey(Schema.Unknown),
  given_name: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  sub: Schema.NonEmptyString,
});

function failedAt(step: string): (failure: unknown) => SignInRefusal {
  return (failure) => {
    if (isGuardRefusal(failure)) {
      return providerFailed(`${step}, on a private address`);
    }
    return providerFailed(step);
  };
}

function answeredBy(client: HttpClient.HttpClient) {
  return <Decoded>({ issuer, request, schema, step }: Call<Decoded>): Effect.Effect<Decoded, SignInRefusal> => {
    const init = providerRequestInitOf(isLoopbackUrl(issuer));
    return client
      .execute(HttpClientRequest.acceptJson(request))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout(Duration.seconds(TIMEOUT_SECONDS)),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provideService(FetchHttpClient.RequestInit, init),
        Effect.mapError(failedAt(step)),
      );
  };
}

function discoveryCall(issuer: string): Call<typeof DiscoverySchema.Type> {
  const url = `${Str.replace(TRAILING_SLASH, "")(issuer)}${DISCOVERY_PATH}`;
  return { issuer, request: HttpClientRequest.get(url), schema: DiscoverySchema, step: DISCOVERY };
}

function providerIn(found: typeof DiscoverySchema.Type): Provider {
  return {
    authorizationEndpoint: found.authorization_endpoint,
    jwksUri: found.jwks_uri,
    tokenEndpoint: found.token_endpoint,
    userinfoEndpoint: found.userinfo_endpoint,
  };
}

function isProviderOf(settings: OidcSettings, found: typeof DiscoverySchema.Type): boolean {
  const endpoints = [found.authorization_endpoint, found.jwks_uri, found.token_endpoint, found.userinfo_endpoint];
  return found.issuer === settings.issuer && Arr.every(endpoints, isEndpointOf(settings.issuer));
}

function clientSecretParams(settings: OidcSettings): Readonly<Record<string, string>> {
  return Option.match(settings.clientSecret, {
    onNone: () => ({}),
    onSome: (secret) => ({ client_secret: Redacted.value(secret) }),
  });
}

function tokenRequest({ code, provider, settings, verifier }: CodeExchange): HttpClientRequest.HttpClientRequest {
  return HttpClientRequest.post(provider.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams({
      client_id: settings.client,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUriOf(settings),
      ...clientSecretParams(settings),
    }),
  );
}

function userInfoWith(answered: ReturnType<typeof answeredBy>): OidcProviderService["userInfo"] {
  return ({ accessToken, provider, settings }) => {
    const request = HttpClientRequest.get(provider.userinfoEndpoint).pipe(
      HttpClientRequest.setHeader("authorization", `${TOKEN_SCHEME} ${accessToken}`),
    );
    return Effect.map(
      answered({ issuer: settings.issuer, request, schema: UserInfoSchema, step: "userinfo endpoint" }),
      (claims) => ({
        email: textOf(claims.email),
        emailVerified: claims.email_verified === true,
        familyName: textOf(claims.family_name),
        givenName: textOf(claims.given_name),
        name: textOf(claims.name),
        sub: claims.sub,
      }),
    );
  };
}

function keySourceOf(answered: ReturnType<typeof answeredBy>): KeySource {
  const keysAt = new Map<string, ReturnType<typeof createLocalJWKSet>>();
  const freshUntil = new Map<string, number>();
  function fetched({ jwksUri, settings }: IdTokenCheck): ReturnType<KeySource["fetched"]> {
    return Effect.gen(function* fetchKeys() {
      const request = HttpClientRequest.get(jwksUri);
      const { keys } = yield* answered({ issuer: settings.issuer, request, schema: JwksSchema, step: "JWKS" });
      const now = yield* DateTime.now;
      const known = createLocalJWKSet({ keys: [...keys] });
      keysAt.set(jwksUri, known);
      freshUntil.set(jwksUri, DateTime.toEpochMillis(DateTime.addDuration(now, KEYS_KEPT)));
      return known;
    });
  }
  return {
    cached: (check) =>
      Effect.flatMap(DateTime.now, (now) => {
        const fresh = (freshUntil.get(check.jwksUri) ?? NEVER) > DateTime.toEpochMillis(now);
        const kept = Option.filter(Option.fromUndefinedOr(keysAt.get(check.jwksUri)), () => fresh);
        return Option.match(kept, { onNone: () => fetched(check), onSome: Effect.succeed });
      }),
    fetched,
  };
}

function providerOn(client: HttpClient.HttpClient): OidcProviderService {
  const answered = answeredBy(client);
  return {
    discovered: (settings) =>
      answered(discoveryCall(settings.issuer)).pipe(
        Effect.filterOrFail(
          (found) => isProviderOf(settings, found),
          () => providerFailed(DISCOVERY),
        ),
        Effect.map(providerIn),
      ),
    tokens: (exchange) =>
      Effect.map(
        answered({
          issuer: exchange.settings.issuer,
          request: tokenRequest(exchange),
          schema: TokenSchema,
          step: "token endpoint",
        }),
        (token) => ({ accessToken: token.access_token, idToken: Option.fromUndefinedOr(token.id_token) }),
      ),
    userInfo: userInfoWith(answered),
    verifiedIdToken: verifiedIdTokenWith(keySourceOf(answered)),
  };
}

const oidcProviderLayer: Layer.Layer<OidcProvider> = Layer.effect(
  OidcProvider,
  Effect.map(HttpClient.HttpClient, providerOn),
).pipe(Layer.provide(FetchHttpClient.layer));

export { type Provider, type UserInfo, OidcProvider, oidcProviderLayer };
export type { Names } from "./id-token.ts";
