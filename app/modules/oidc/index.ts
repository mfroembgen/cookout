/**
 * Signing a person in to the web UI through an OpenID Connect provider, on the wire, shared by the server, the SDK
 * and the web: the routes, the answer that says whether the server has it on, the codes a refused sign-in answers
 * with and the web UI's path that shows one. A fork patch, since upstream ADR 0003 rejected OAuth (ADR 0107).
 */
import type { ErrorCode } from "../http/index.ts";
import { isUserCode } from "../logins/index.ts";

declare const brand: unique symbol;

const LINK_ID = /^[0-9a-f]{64}$/u;

const APPROVAL = /^#\/approve(?:-join)?\/(?<code>[^/]+)$/u;
const HASH_MARK = /^#/u;

const signInRefusalCodes = [
  "oidc_state_missing",
  "oidc_state_mismatch",
  "oidc_issuer_mismatch",
  "oidc_provider_refused",
  "oidc_provider_failed",
  "oidc_email_unverified",
  "oidc_email_not_allowed",
  "oidc_name_unusable",
  "oidc_name_taken",
  "oidc_id_token_invalid",
  "oidc_sign_in_changed",
  "identity_deactivated",
] as const satisfies readonly ErrorCode[];

/**
 * The answer to `GET /v1/sign-in`: whether the server signs people in through an OpenID Connect provider, and if so
 * the provider's name the web UI shows, such as `Google` (`COOKOUT_OIDC_LABEL`), and `start`, the absolute
 * `GET /v1/oidc/start` URL on the board's public URL, which every sign-in starts from.
 */
export type SignInResponse =
  | { readonly oidc: false }
  | { readonly oidc: true; readonly label: string; readonly start: string };

/** `GET /v1/sign-in` (no token): how a person can sign in to the web UI here. */
export const signInPath = "/v1/sign-in";

/**
 * `GET /v1/oidc/start` (no token, only with OIDC on): sends the browser on to the provider to sign in, with a
 * short-lived cookie that the callback checks.
 */
export const oidcStartPath = "/v1/oidc/start";

/** The query parameter of `GET /v1/oidc/start` naming the web UI page to come back to once signed in. */
export const signInReturnParameter = "return";

/**
 * The web UI page a sign-in started with `return` sends the browser back to: only a login request's or an agent join
 * request's approval page (`#/approve/<user code>` or `#/approve-join/<user code>`, a well-formed user code), so a
 * person who opened an approval link signed out lands on it again. Anything else is the homepage (`""`).
 * @param value The `return` the sign-in started with, `""` when none.
 * @returns The hash to come back to, or `""`.
 */
export function signInReturnOf(value: string): string {
  if (!APPROVAL.test(value) || !isUserCode(value.replace(APPROVAL, "$<code>"))) {
    return "";
  }
  return value;
}

/**
 * The link that starts a sign-in at `start` and comes back to `back`, a page `signInReturnOf` allows, or to the
 * homepage.
 * @param starting `start`, the absolute `GET /v1/oidc/start` URL, and `back`, the hash to come back to (`""` for the
 * homepage).
 * @returns `start`, with `return` when there is a page to come back to.
 */
export function signInStartHref(starting: SignInStart): string {
  if (signInReturnOf(starting.back) === "") {
    return starting.start;
  }
  return `${starting.start}?${signInReturnParameter}=${encodeURIComponent(starting.back)}`;
}

/** Where a sign-in starts, `GET /v1/oidc/start` on the public URL, and the page it comes back to, `""` for none. */
export interface SignInStart {
  readonly start: string;
  readonly back: string;
}

/**
 * `GET /v1/oidc/callback` (no token, only with OIDC on): where the provider sends the browser back. It signs the
 * person in as the human named by their email address and sends the browser to the web UI, or to the login view
 * with the refusal's code.
 */
export const oidcCallbackPath = "/v1/oidc/callback";

/**
 * The codes a refused sign-in sends the browser to the login view with: no sign-in cookie, or one past its 10 minutes
 * (`oidc_state_missing`), a `state` or `iss` that isn't this sign-in's, the provider sending back an error, the
 * provider failing to answer or answering something unexpected, an email address the provider doesn't call verified
 * or that isn't in the allowed domain, a name the address can't become, a name an agent has, and a Deactivated human.
 */
export type SignInRefusalCode = (typeof signInRefusalCodes)[number];

/**
 * Whether `value` is a code a refused sign-in sends the browser to the login view with.
 * @param value The text to check, such as the last part of `#/login/<code>`.
 * @returns Whether it is a `SignInRefusalCode`.
 */
export function isSignInRefusalCode(value: string): value is SignInRefusalCode {
  return signInRefusalCodes.some((code) => code === value);
}

/**
 * The web UI's path that shows a refused sign-in on the login view, keeping the approval page the sign-in started
 * from, so signing in again from there comes back to it.
 * @param refused The refusal's `code`, and `back`, the page the sign-in started from (`""` for none; only one
 * `signInReturnOf` allows is kept).
 * @returns The path, such as `/#/login/oidc_email_not_allowed` or `/#/login/oidc_provider_refused/approve/ABCD-1234`.
 */
export function signInRefusalPathOf(refused: RefusedSignIn): string {
  return `/#/login/${refused.code}${signInReturnOf(refused.back).replace(HASH_MARK, "")}`;
}

/** A refused sign-in: its code and the approval page it started from, `""` for none. */
export interface RefusedSignIn {
  readonly code: SignInRefusalCode;
  readonly back: string;
}

/** The SDK's call for how a person can sign in. */
export interface SignInCalls {
  /** `GET /v1/sign-in` (no token): whether the server signs people in through an OpenID Connect provider. */
  readonly signIn: () => Promise<SignInResponse>;
}

/** The random ID a single sign-on link gets when it is made, so a link made again is never taken for the one read before. */
export type OidcLinkId = string & { readonly [brand]: "OidcLinkId" };

/**
 * Whether `value` looks like a link ID, 64 lowercase hex characters; if so, it is an `OidcLinkId`.
 * @param value The ID to check.
 * @returns Whether `value` is an `OidcLinkId`.
 */
export function isOidcLinkId(value: string): value is OidcLinkId {
  return LINK_ID.test(value);
}
