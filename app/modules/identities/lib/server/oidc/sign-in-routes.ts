import { Option, Schema } from "effect";
import { oidcStartPath, signInPath } from "../../../../oidc/index.ts";
import { HttpServerResponse } from "effect/http";
import type { OidcSettings } from "./settings.ts";
import type { SignInResponse } from "../../../../oidc/index.ts";
import type { SignInRoute } from "./sign-in-layer.ts";
import { callbackRoute } from "./callback.ts";
import { matchesWire } from "../../../../http/index.ts";
import { openRoute } from "./login-view.ts";
import { originOf } from "./settings.ts";
import { startRoute } from "./start.ts";

const OidcOff = Schema.Struct({ oidc: Schema.Literal(false) });

const OidcOn = Schema.Struct({ label: Schema.String, oidc: Schema.Literal(true), start: Schema.String });

const SignInResponseSchema = matchesWire<SignInResponse>()(Schema.Union([OidcOff, OidcOn]));

function signInRoute(answer: SignInResponse): ReturnType<typeof openRoute<never, never>> {
  return openRoute({ flow: HttpServerResponse.schemaJson(SignInResponseSchema)(answer), path: signInPath });
}

function signInRoutes(settings: Option.Option<OidcSettings>): readonly SignInRoute[] {
  return Option.match(settings, {
    onNone: () => [signInRoute({ oidc: false })],
    onSome: (on) => [
      signInRoute({ label: on.label, oidc: true, start: `${originOf(on)}${oidcStartPath}` }),
      startRoute(on),
      callbackRoute(on),
    ],
  });
}

const signInResponseSchemas = { SignInResponse: SignInResponseSchema };

export { signInResponseSchemas, signInRoutes };
