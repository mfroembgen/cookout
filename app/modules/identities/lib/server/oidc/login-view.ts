import { Effect, Function, Option, Predicate } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { failureResponse, httpResponseSchemas } from "../../../../http/server.ts";
import { isSignInRefusalCode, signInRefusalPathOf } from "../../../../oidc/index.ts";
import { AddressLimit } from "../login-support.ts";
import { NOT_STORED } from "../sign-in-shown.ts";
import type { OidcSettings } from "./settings.ts";
import type { Refusal } from "../../../../http/index.ts";
import type { Route } from "../../../../http/server.ts";
import type { SignInRefusal } from "./refusals.ts";
import { originOf } from "./settings.ts";
import { stateCookieOf } from "./state-cookie.ts";

type Answer = HttpServerResponse.HttpServerResponse;

type Request = HttpServerRequest.HttpServerRequest;

interface OpenFlow<Failure, Needs> {
  readonly flow: Effect.Effect<Answer, Failure, Needs | Request>;
  readonly path: string;
}

interface SignInFlow<Failure, Needs> {
  readonly flow: Effect.Effect<Answer, Failure | SignInRefusal, Needs | Request>;
  readonly path: string;
  readonly settings: OidcSettings;
}

const FOUND = 302;

function admitted<Value, Failure, Needs>(
  effect: Effect.Effect<Value, Failure, Needs>,
): Effect.Effect<Value, Failure | Refusal, Needs | AddressLimit | Request> {
  return Effect.gen(function* admitAddressThenRun() {
    const limit = yield* AddressLimit;
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* limit.admit(Option.getOrElse(request.remoteAddress, Function.constant("unknown")));
    return yield* effect;
  });
}

function openRoute<Failure, Needs>({ flow, path }: OpenFlow<Failure, Needs>): Route<Needs | AddressLimit> {
  return { handle: () => admitted(flow), method: "GET", path };
}

function isSignInRefusal(failure: unknown): failure is SignInRefusal {
  return (
    Predicate.hasProperty(failure, "code") && Predicate.isString(failure.code) && isSignInRefusalCode(failure.code)
  );
}

function withoutStateCookie(settings: OidcSettings): (response: Answer) => Effect.Effect<Answer> {
  const { name, options } = stateCookieOf(settings);
  return (response) => Effect.orDie(HttpServerResponse.expireCookie(response, name, options));
}

function toLoginView(settings: OidcSettings): (refusal: SignInRefusal) => Effect.Effect<Answer> {
  return ({ back = "", status: _status, ...error }) =>
    Effect.gen(function* sendToLoginView() {
      const location = `${originOf(settings)}${signInRefusalPathOf({ back, code: error.code })}`;
      const answer = HttpServerResponse.schemaJson(httpResponseSchemas.ErrorResponse);
      const response = yield* answer({ error }, { headers: { location }, status: FOUND });
      return yield* withoutStateCookie(settings)(response);
    }).pipe(Effect.orDie);
}

function clearingStateCookie(settings: OidcSettings): (error: unknown) => Effect.Effect<Answer> {
  return (error) => Effect.flatMap(failureResponse(error), withoutStateCookie(settings));
}

function refusedToLoginView<Failure, Needs>({
  flow,
  path,
  settings,
}: SignInFlow<Failure, Needs>): Route<Needs | AddressLimit> {
  const refused = Effect.catchIf(
    flow,
    (failure: Failure | SignInRefusal): failure is SignInRefusal => isSignInRefusal(failure),
    toLoginView(settings),
  );
  const answered = Effect.matchEffect(admitted(refused), {
    onFailure: clearingStateCookie(settings),
    onSuccess: Effect.succeed,
  }).pipe(Effect.map(HttpServerResponse.setHeaders(NOT_STORED)));
  return { handle: () => answered, method: "GET", path };
}

function comingBackTo(
  back: string,
): <Value, Failure, Needs>(work: Effect.Effect<Value, Failure, Needs>) => Effect.Effect<Value, Failure, Needs> {
  return (work) => Effect.catchIf(work, isSignInRefusal, (refusal) => Effect.fail({ ...refusal, back }));
}

export { comingBackTo, openRoute, refusedToLoginView };
