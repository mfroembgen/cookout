import type { AddressLimit } from "../login-support.ts";
import { Layer } from "effect";
import type { OidcProvider } from "../routes/oidc-provider.ts";
import type { Route } from "../../../../http/server.ts";
import type { Secrets } from "../../../../secrets/server.ts";
import type { SignInNeeds } from "./sign-in.ts";
import type { SignInSeal } from "./seal.ts";
import { oidcProviderLayer } from "../routes/oidc-provider.ts";
import { signInSealLayer } from "./seal.ts";

const signInLayer: Layer.Layer<OidcProvider | SignInSeal, never, Secrets> = Layer.merge(
  oidcProviderLayer,
  signInSealLayer,
);

type SignInRoute = Route<SignInNeeds | OidcProvider | SignInSeal | AddressLimit>;

export { type SignInRoute, signInLayer };
