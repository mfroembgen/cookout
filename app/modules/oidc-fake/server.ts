/**
 * A fake OpenID Connect provider: a real HTTP server on `127.0.0.1` and a free port that stands in for one such as
 * WorkOS AuthKit, for the cookout's single sign-on (ADR 0107). `OidcFake` gives its `issuer` (its base URL) and the
 * `client` (the client ID, and `clientSecret` when given one) the cookout is registered with.
 *
 * It answers `GET /.well-known/openid-configuration` with its endpoints. `GET /authorize` checks an Authorization
 * Code request with PKCE S256 (`response_type=code`, the client ID, `openid` in the scope, a `redirect_uri`, `state`,
 * a nonce and a challenge; else 400) and sends the browser straight back to the `redirect_uri` with a code for the
 * user `signInAs` named, `state` and `iss`. `POST /token` takes the form `client_secret_post` sends: a code is good
 * once, for the client ID, the `redirect_uri` it was given for and a verifier of 43 to 128 characters whose S256
 * challenge it was given (and the client secret, when the fake has one); else 400 `invalid_grant`. `GET /userinfo`
 * answers the user's claims for an access token it issued (`email`, `email_verified`, any `name`, `given_name` and
 * `family_name`, and `sub`: the user's `subject`, else `fake|<email>`), else 401.
 *
 * `refuseNext(error)` sends the next authorization back with `error` instead of a code; `sendIssuer(iss)` sends
 * every later one back with that `iss`; `announce(fields)` puts fields in the discovery document over its own, such as
 * another `issuer` or a `token_endpoint` elsewhere. It signs an RS256 ID token for each code, with the nonce the
 * authorization asked for, its keys at `GET /jwks`; `nextIdToken(changes)` changes the next one: leaves it out, signs it
 * with a key it doesn't publish, signs it with a new key it publishes from then on, beside the old one (`rotated`) or in its place under the same key ID (`rekeyed`), makes it expired, sets claims over its own, or drops the claims it names `without`.
 * `oidcFake` is a scoped Layer: the server stops when its scope closes. Reachable only from tests and `testing`.
 */
import { Context, Effect, Layer, Option } from "effect";
import type { FakeUser, IdTokenChanges } from "./lib/server/state.ts";
import { fakeProvider } from "./lib/server/provider.ts";
import { secretsLive } from "../secrets/server.ts";

interface OidcFakeService {
  readonly issuer: string;
  readonly client: string;
  readonly clientSecret: Option.Option<string>;
  readonly announce: (fields: Readonly<Record<string, string>>) => Effect.Effect<void>;
  readonly nextIdToken: (changes: IdTokenChanges) => Effect.Effect<void>;
  readonly refuseNext: (error: string) => Effect.Effect<void>;
  readonly sendIssuer: (issuer: string) => Effect.Effect<void>;
  readonly signInAs: (user: FakeUser) => Effect.Effect<void>;
}

interface OidcFakeOptions {
  readonly clientSecret?: string;
}

const CLIENT = "cookout-test-client";

class OidcFake extends Context.Service<OidcFake, OidcFakeService>()("@ai-hero/cookout/oidc-fake/server/OidcFake") {}

function oidcFake(options: OidcFakeOptions = {}): Layer.Layer<OidcFake> {
  const clientSecret = Option.fromUndefinedOr(options.clientSecret);
  return Layer.effect(
    OidcFake,
    Effect.map(fakeProvider({ client: CLIENT, clientSecret }), (provider) =>
      OidcFake.of({ ...provider, client: CLIENT, clientSecret }),
    ),
  ).pipe(Layer.provide(secretsLive));
}

export type { FakeUser, IdTokenChanges } from "./lib/server/state.ts";
export { OidcFake, type OidcFakeOptions, type OidcFakeService, oidcFake };
