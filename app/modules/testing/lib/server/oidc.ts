import {
  Array as Arr,
  Effect,
  Function,
  Layer,
  Option,
  Predicate,
  Record as Rec,
  Redacted,
  String as Str,
} from "effect";
import { Cookies, HttpClient, HttpClientRequest } from "effect/http";
import type { FakeUser, OidcFakeOptions } from "../../../oidc-fake/server.ts";
import type { HttpRequest, HttpResponse } from "../../../http/client.ts";
import { OidcFake, oidcFake } from "../../../oidc-fake/server.ts";
import { TestCookout, testCookout } from "./cookout.ts";
import { isOidcLinkId, oidcCallbackPath, oidcStartPath, signInReturnParameter } from "../../../oidc/index.ts";
import { NodeHttpClient } from "@effect/platform-node";
import type { OidcLinkId } from "../../../oidc/index.ts";
import type { StorageKind } from "./backing.ts";
import { answer } from "./calls.ts";
import { request } from "../../../http/client.ts";
import { whoamiPath } from "../../../identities/index.ts";

interface StartedOidcSignIn {
  readonly response: HttpResponse;
  readonly stateCookie: string;
  readonly providerUrl: string;
}

interface ReturnedOidcSignIn {
  readonly response: HttpResponse;
  readonly callbackUrl: string;
}

interface OidcReturn {
  readonly url: string;
  readonly callbackUrl: string;
  readonly cookie: string;
}

interface FinishedOidcSignIn {
  readonly response: HttpResponse;
  readonly sessionCookie: Option.Option<string>;
}

type Address = Omit<HttpRequest, "method">;

const BOARD_URL = "https://board.example.com";
const EMAIL_DOMAIN = "example.com";
const STATE_COOKIES = ["__Host-cookout_oidc", "cookout_oidc"] as const;
const SESSION_COOKIE = "cookout_session";
const NO_LOCATION = "http://location.invalid/";
const BAD_REQUEST = 400;
const LINK_ID_LENGTH = 64;
const NO_OFFSET = 0;

interface OidcCookoutOptions extends OidcFakeOptions {
  readonly publicUrl?: string;
  readonly label?: string;
  readonly issuerHost?: string;
  readonly storage?: StorageKind;
  readonly requestsPerMinute?: number;
}

function linkIdOf(label: string): OidcLinkId {
  const hex = Str.slice(NO_OFFSET, LINK_ID_LENGTH)(Str.padEnd(LINK_ID_LENGTH, "0")(Buffer.from(label).toString("hex")));
  return Option.getOrThrow(Option.liftPredicate(hex, isOidcLinkId));
}

function testCookoutWithOidc(
  options: OidcCookoutOptions = {},
): Layer.Layer<TestCookout | OidcFake | HttpClient.HttpClient> {
  const publicUrl = options.publicUrl ?? BOARD_URL;
  const cookout = Layer.unwrap(
    Effect.map(OidcFake, (fake) =>
      testCookout({
        oidc: {
          client: fake.client,
          clientSecret: Option.map(fake.clientSecret, (secret) => Redacted.make(secret)),
          emailDomain: EMAIL_DOMAIN,
          issuer: Str.replace("127.0.0.1", options.issuerHost ?? "127.0.0.1")(fake.issuer),
          label: options.label ?? "single sign-on",
          publicUrl,
        },
        publicUrl,
        ...Option.match(Option.fromUndefinedOr(options.storage), {
          onNone: () => ({}),
          onSome: (storage) => ({ storage }),
        }),
        ...Option.match(Option.fromUndefinedOr(options.requestsPerMinute), {
          onNone: () => ({}),
          onSome: (requestsPerMinute) => ({ requestsPerMinute }),
        }),
      }),
    ),
  );
  return Layer.mergeAll(Layer.provideMerge(cookout, oidcFake(options)), NodeHttpClient.layerNodeHttp);
}

function cookieNamed(response: HttpResponse, name: string): Option.Option<string> {
  const found = Arr.findFirst(response.headers.getSetCookie(), Str.startsWith(`${name}=`));
  return Option.map(found, (cookie) => Arr.headNonEmpty(Str.split(";")(cookie)));
}

function locationOf(response: HttpResponse): string {
  return response.headers.get("location") ?? NO_LOCATION;
}

function get(address: Address): Effect.Effect<HttpResponse> {
  return answer(() => request({ ...address, method: "GET" }));
}

function addressOf(url: string): Address {
  const { origin, pathname, searchParams } = new URL(url);
  return { baseUrl: origin, path: pathname, query: Rec.fromEntries(searchParams) };
}

function startedFrom(response: HttpResponse): StartedOidcSignIn {
  return {
    providerUrl: locationOf(response),
    response,
    stateCookie: Option.getOrElse(
      Option.firstSomeOf(Arr.map(STATE_COOKIES, (name) => cookieNamed(response, name))),
      () => "",
    ),
  };
}

function headersOf(received: Readonly<Record<string, unknown>>, cookies: readonly string[]): Headers {
  const headers = new Headers();
  for (const [name, value] of Rec.toEntries(received)) {
    if (name !== "set-cookie" && Predicate.isString(value)) {
      headers.set(name, value);
    }
  }
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}

interface AsHost {
  readonly host: string;
  readonly path: string;
}

function asPublicHost(
  baseUrl: string,
  { host, path }: AsHost,
): Effect.Effect<HttpResponse, never, HttpClient.HttpClient> {
  return Effect.gen(function* requestAsPublicHost() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.setHeader(HttpClientRequest.get(`${baseUrl}${path}`), "host", host),
    );
    const text = yield* response.text;
    const headers = headersOf(response.headers, Cookies.toSetCookieHeaders(response.cookies));
    const answered = { headers, ok: response.status < BAD_REQUEST, status: response.status, text };
    const json = yield* Effect.option(response.json);
    return Option.match(json, { onNone: () => answered, onSome: (body) => ({ ...answered, json: body }) });
  }).pipe(Effect.orDie);
}

function startedAt(address: Address): Effect.Effect<StartedOidcSignIn, never, HttpClient.HttpClient> {
  return Effect.flatMap(get(address), (first) => {
    const canonical = new URL(locationOf(first));
    if (canonical.pathname !== oidcStartPath) {
      return Effect.succeed(startedFrom(first));
    }
    return Effect.map(
      asPublicHost(address.baseUrl, { host: canonical.host, path: `${canonical.pathname}${canonical.search}` }),
      startedFrom,
    );
  });
}

function startOidcSignIn(url: string): Effect.Effect<StartedOidcSignIn, never, HttpClient.HttpClient> {
  return startedAt({ baseUrl: url, path: oidcStartPath });
}

function startOidcSignInBackTo(
  back: string,
): Effect.Effect<StartedOidcSignIn, never, TestCookout | HttpClient.HttpClient> {
  return Effect.flatMap(TestCookout, (cookout) =>
    startedAt({ baseUrl: cookout.url, path: oidcStartPath, query: { [signInReturnParameter]: back } }),
  );
}

function authorizeAt(providerUrl: string): Effect.Effect<ReturnedOidcSignIn> {
  return Effect.map(get(addressOf(providerUrl)), (response) => ({ callbackUrl: locationOf(response), response }));
}

function finishOidcSignIn({ callbackUrl, cookie, url }: OidcReturn): Effect.Effect<FinishedOidcSignIn> {
  const returned = { ...addressOf(callbackUrl), baseUrl: url, headers: { cookie }, path: oidcCallbackPath };
  return Effect.map(get(returned), (response) => ({ response, sessionCookie: cookieNamed(response, SESSION_COOKIE) }));
}

function signedInAs(
  user: FakeUser,
): Effect.Effect<FinishedOidcSignIn, never, OidcFake | TestCookout | HttpClient.HttpClient> {
  return Effect.gen(function* signInAsUser() {
    const fake = yield* OidcFake;
    const cookout = yield* TestCookout;
    yield* fake.signInAs(user);
    const started = yield* startOidcSignIn(cookout.url);
    const { callbackUrl } = yield* authorizeAt(started.providerUrl);
    return yield* finishOidcSignIn({ callbackUrl, cookie: started.stateCookie, url: cookout.url });
  });
}

function whoamiAfter(finished: FinishedOidcSignIn): Effect.Effect<unknown, never, TestCookout> {
  return Effect.gen(function* whoamiWithCookie() {
    const cookout = yield* TestCookout;
    const cookie = Option.getOrElse(finished.sessionCookie, Function.constant(""));
    const response = yield* get({ baseUrl: cookout.url, headers: { cookie }, path: whoamiPath });
    return response.json;
  });
}

export {
  type FinishedOidcSignIn,
  type ReturnedOidcSignIn,
  type StartedOidcSignIn,
  authorizeAt,
  finishOidcSignIn,
  linkIdOf,
  signedInAs,
  startOidcSignIn,
  startOidcSignInBackTo,
  testCookoutWithOidc,
  whoamiAfter,
};
