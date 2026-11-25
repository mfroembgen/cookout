import { Context, Effect, Layer, Option, String as Str } from "effect";
import { Secrets } from "../../../../secrets/server.ts";
import type { WebhookCommandSecret } from "../../../../webhook-commands/index.ts";

interface SignInSealService {
  readonly sealed: (value: string) => Effect.Effect<string>;
  readonly opened: (sealed: string) => Effect.Effect<Option.Option<string>>;
}

class SignInSeal extends Context.Service<SignInSeal, SignInSealService>()(
  "@ai-hero/cookout/identities/lib/server/oidc/seal/SignInSeal",
) {}

const SEPARATOR = ".";
const START = 0;

interface Keyed {
  readonly key: Effect.Effect<WebhookCommandSecret>;
  readonly secrets: Secrets["Service"];
}

interface Sealed {
  readonly mac: string;
  readonly value: string;
}

function macOf({ key, secrets }: Keyed): (value: string) => Effect.Effect<string> {
  return (value) => Effect.flatMap(key, (made) => secrets.signature(made, value));
}

function sameMacIn(keyed: Keyed): (sealed: Sealed) => Effect.Effect<boolean> {
  return ({ mac, value }) =>
    Effect.gen(function* compareMacs() {
      const expected = yield* Effect.flatMap(macOf(keyed)(value), keyed.secrets.digest);
      const sent = yield* keyed.secrets.digest(mac);
      return expected === sent;
    });
}

const signInSealLayer: Layer.Layer<SignInSeal, never, Secrets> = Layer.effect(
  SignInSeal,
  Effect.gen(function* makeSignInSeal() {
    const secrets = yield* Secrets;
    const key = yield* Effect.cached(secrets.newWebhookCommandSecret);
    const keyed = { key, secrets };
    const sameMac = sameMacIn(keyed);
    return SignInSeal.of({
      opened: (sealed) =>
        Effect.gen(function* openSealed() {
          const at = Option.getOrElse(Str.lastIndexOf(SEPARATOR)(sealed), () => START);
          const value = Str.slice(START, at)(sealed);
          const matches = yield* sameMac({ mac: Str.slice(at + SEPARATOR.length)(sealed), value });
          return Option.liftPredicate(value, () => matches);
        }),
      sealed: (value) => Effect.map(macOf(keyed)(value), (mac) => `${value}${SEPARATOR}${mac}`),
    });
  }),
);

export { SignInSeal, signInSealLayer };
