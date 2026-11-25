import { Effect, Record as Rec } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { comingBackTo, refusedToLoginView } from "./login-view.ts";
import { isLoopbackUrl, redirectUriOf } from "./settings.ts";
import { oidcStartPath, signInReturnOf, signInReturnParameter, signInStartHref } from "../../../../oidc/index.ts";
import { startedSignIn, stateCookieLifetime, stateCookieOf, stateCookieValue } from "./state-cookie.ts";
import { OidcProvider } from "../routes/oidc-provider.ts";
import type { OidcSettings } from "./settings.ts";
import type { Provider } from "../routes/oidc-provider.ts";
import type { SignInRoute } from "./sign-in-layer.ts";
import type { StartedSignIn } from "./state-cookie.ts";

interface Authorization {
  readonly provider: Provider;
  readonly settings: OidcSettings;
  readonly started: StartedSignIn;
}

const OPENID_SCOPE = "openid email profile";
const PATH_BASE = "http://cookout.invalid";

function authorizationUrl({ provider, settings, started }: Authorization): string {
  const url = new URL(provider.authorizationEndpoint);
  const params = {
    client_id: settings.client,
    code_challenge: started.challenge,
    code_challenge_method: "S256",
    nonce: started.nonce,
    redirect_uri: redirectUriOf(settings),
    response_type: "code",
    scope: OPENID_SCOPE,
    state: started.state,
  };
  for (const [name, value] of Rec.toEntries(params)) {
    url.searchParams.append(name, value);
  }
  return url.href;
}

const toProvider = Effect.fnUntraced(function* sendToProvider(settings: OidcSettings, back: string) {
  const oidc = yield* OidcProvider;
  const provider = yield* oidc.discovered(settings);
  const started = yield* startedSignIn(back);
  const value = yield* stateCookieValue(started);
  const response = HttpServerResponse.redirect(authorizationUrl({ provider, settings, started }));
  const { name, options } = stateCookieOf(settings);
  return yield* HttpServerResponse.setCookie(response, name, value, { ...options, maxAge: stateCookieLifetime });
});

function startRoute(settings: OidcSettings): SignInRoute {
  const flow = Effect.gen(function* startSignIn() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const back = signInReturnOf(new URL(request.url, PATH_BASE).searchParams.get(signInReturnParameter) ?? "");
    const publicUrl = new URL(settings.publicUrl);
    if (isLoopbackUrl(settings.publicUrl) && request.headers["host"] !== publicUrl.host) {
      return HttpServerResponse.redirect(signInStartHref({ back, start: `${publicUrl.origin}${oidcStartPath}` }));
    }
    return yield* comingBackTo(back)(toProvider(settings, back));
  });
  return refusedToLoginView({ flow, path: oidcStartPath, settings });
}

export { startRoute };
