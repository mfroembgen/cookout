import { Effect, Predicate, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { comingBackTo, refusedToLoginView } from "./login-view.ts";
import { idTokenInvalid, issuerMismatch, providerRefused, stateMismatch, stateMissing } from "./refusals.ts";
import { sentState, stateCookieOf } from "./state-cookie.ts";
import { OidcProvider } from "../routes/oidc-provider.ts";
import type { OidcSettings } from "./settings.ts";
import type { SignInRoute } from "./sign-in-layer.ts";
import type { SignInState } from "./state-cookie.ts";
import { oidcCallbackPath } from "./settings.ts";
import { sessionCookie } from "../session.ts";
import { signedInHuman } from "./sign-in.ts";

interface Returned {
  readonly query: CallbackQuery;
  readonly settings: OidcSettings;
}

const PATH_BASE = "http://cookout.invalid";
const NO_CODE = "no_code";

const CallbackQuerySchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  iss: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
});

type CallbackQuery = typeof CallbackQuerySchema.Type;

const callbackQuery = Effect.gen(function* readCallbackQuery() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const search = HttpServerRequest.searchParamsFromURL(new URL(request.url, PATH_BASE));
  return yield* HttpServerRequest.schemaSearchParams(CallbackQuerySchema).pipe(
    Effect.provideService(HttpServerRequest.ParsedSearchParams, search),
    Effect.mapError(() => stateMismatch),
  );
});

function issuerChecked({ query, settings }: Returned): Effect.Effect<void, ReturnType<typeof issuerMismatch>> {
  if (Predicate.isNotUndefined(query.iss) && query.iss !== settings.issuer) {
    return Effect.fail(issuerMismatch(query.iss));
  }
  return Effect.void;
}

const signInOfThisBrowser = Effect.fnUntraced(function* checkReturn(returned: Returned) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sent = yield* sentState({ cookies: request.cookies, settings: returned.settings });
  if (sent.status === "missing") {
    return yield* Effect.fail(stateMissing);
  }
  if (sent.status === "forged" || returned.query.state !== sent.signIn.state) {
    return yield* Effect.fail(stateMismatch);
  }
  return sent.signIn;
});

function codeIn({ code, error }: CallbackQuery): Effect.Effect<string, ReturnType<typeof providerRefused>> {
  if (Predicate.isNotUndefined(error) || Predicate.isUndefined(code)) {
    return Effect.fail(providerRefused(error ?? NO_CODE));
  }
  return Effect.succeed(code);
}

const verifiedPerson = Effect.fnUntraced(function* exchangeAndVerify(signIn: SignInState, settings: OidcSettings) {
  const query = yield* callbackQuery;
  const code = yield* codeIn(query);
  const oidc = yield* OidcProvider;
  const provider = yield* oidc.discovered(settings);
  const tokens = yield* oidc.tokens({ code, provider, settings, verifier: signIn.verifier });
  const { jwksUri } = provider;
  const verified = yield* oidc.verifiedIdToken({ idToken: tokens.idToken, jwksUri, nonce: signIn.nonce, settings });
  const info = yield* oidc.userInfo({ accessToken: tokens.accessToken, provider, settings });
  return yield* Effect.filterOrFail(
    Effect.succeed({ info, verified }),
    () => info.sub === verified.subject,
    () => idTokenInvalid("sub"),
  );
});

const signedInFrom = Effect.fnUntraced(function* finishSignIn(signIn: SignInState, settings: OidcSettings) {
  const { info, verified } = yield* verifiedPerson(signIn, settings);
  const { token: credential } = yield* signedInHuman({
    domain: settings.emailDomain,
    idTokenNames: verified.names,
    info,
    subject: { issuer: settings.issuer, subject: verified.subject },
  });
  const back = HttpServerResponse.redirect(`${new URL(settings.publicUrl).origin}/${signIn.returnTo}`);
  const session = yield* sessionCookie;
  const signedIn = yield* HttpServerResponse.setCookie(back, session.name, credential, session.options);
  const { name, options } = stateCookieOf(settings);
  return yield* HttpServerResponse.expireCookie(signedIn, name, options);
});

function callbackRoute(settings: OidcSettings): SignInRoute {
  const flow = Effect.gen(function* signInFromCallback() {
    const query = yield* callbackQuery;
    const signIn = yield* signInOfThisBrowser({ query, settings });
    const finished = Effect.andThen(issuerChecked({ query, settings }), signedInFrom(signIn, settings));
    return yield* comingBackTo(signIn.returnTo)(finished);
  });
  return refusedToLoginView({ flow, path: oidcCallbackPath, settings });
}

export { callbackRoute };
