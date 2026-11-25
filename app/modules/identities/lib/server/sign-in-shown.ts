import { Context, Effect, Function, Option } from "effect";
import type { Identity, IdentityResponse } from "../../index.ts";
import { Storage } from "../../../storage/server.ts";
import type { StorageUnavailable } from "../../../storage/server.ts";

interface Shown {
  readonly identity: Identity;
  readonly viewer: Identity;
}

const SignInIssuer = Context.Reference<Option.Option<string>>("cookout/identities/SignInIssuer", {
  defaultValue: Function.constant(Option.none()),
});

function mayShow({ identity, viewer }: Shown): boolean {
  return identity.kind === "human" && (viewer.admin || viewer.name === identity.name);
}

function shownTo(shown: Shown): Effect.Effect<IdentityResponse, StorageUnavailable, Storage> {
  return Effect.gen(function* withSignIn() {
    const { identity } = shown;
    const configured = yield* SignInIssuer;
    const issuer = Option.filter(configured, () => mayShow(shown));
    if (Option.isNone(issuer)) {
      return { identity };
    }
    const storage = yield* Storage;
    const signIn = yield* storage.findOidcLinkOf({ identity: identity.name, issuer: issuer.value });
    return Option.match(Option.fromUndefinedOr(signIn), {
      onNone: Function.constant({ identity }),
      onSome: (link) => ({ identity, signIn: link }),
    });
  });
}

const NOT_STORED = { "cache-control": "no-store" } as const;

export { NOT_STORED, SignInIssuer, shownTo };
