import type { Refusal } from "../../../../http/index.ts";
import type { SignInRefusalCode } from "../../../../oidc/index.ts";
import { echoed } from "../../../../http/index.ts";

type SignInRefusal = Refusal & { readonly code: SignInRefusalCode; readonly back?: string };

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const CONFLICT = 409;
const BAD_GATEWAY = 502;

const stateMissing: SignInRefusal = {
  code: "oidc_state_missing",
  message:
    "This sign-in has no sign-in cookie: it took longer than 10 minutes, was finished already, or started in another browser. Sign in again.",
  status: BAD_REQUEST,
};

const stateMismatch: SignInRefusal = {
  code: "oidc_state_mismatch",
  message: "This sign-in's state doesn't match the one this browser started. Sign in again.",
  status: BAD_REQUEST,
};

function issuerMismatch(issuer: string): SignInRefusal {
  return {
    code: "oidc_issuer_mismatch",
    message: `The sign-in came back from ${echoed(issuer)}, not from this board's provider. Sign in again.`,
    status: BAD_REQUEST,
  };
}

function providerRefused(error: string): SignInRefusal {
  return {
    code: "oidc_provider_refused",
    details: { error: echoed(error) },
    message: `The sign-in provider didn't sign you in (${echoed(error)}).`,
    status: FORBIDDEN,
  };
}

function providerFailed(step: string): SignInRefusal {
  return {
    code: "oidc_provider_failed",
    details: { step },
    message: `The sign-in provider's ${step} didn't answer as OpenID Connect says it should. Try again, or ask an admin to check COOKOUT_OIDC_ISSUER.`,
    status: BAD_GATEWAY,
  };
}

const emailUnverified: SignInRefusal = {
  code: "oidc_email_unverified",
  message: "The sign-in provider doesn't say your email address is verified, so it can't sign you in here.",
  status: FORBIDDEN,
};

function emailNotAllowed(domain: string): SignInRefusal {
  return {
    code: "oidc_email_not_allowed",
    message: `Only an email address at ${domain} can sign in here.`,
    status: FORBIDDEN,
  };
}

function nameUnusable(local: string): SignInRefusal {
  return {
    code: "oidc_name_unusable",
    message: `The email address's name ${echoed(local)} can't be an identity name (1 to 64 lowercase letters, digits or \`-\`, with \`.\` and \`_\` read as \`-\`). Ask an admin.`,
    status: FORBIDDEN,
  };
}

function nameTaken(name: string): SignInRefusal {
  return {
    code: "oidc_name_taken",
    message: `${name} is already on this board, so single sign-on can't make it. Ask an admin.`,
    status: FORBIDDEN,
  };
}

function idTokenInvalid(reason: string): SignInRefusal {
  return {
    code: "oidc_id_token_invalid",
    details: { reason: echoed(reason) },
    message: `The sign-in provider's ID token didn't check out (${echoed(reason)}). Try again, or ask an admin to check the provider.`,
    status: BAD_GATEWAY,
  };
}

function signInChanged(who: string): SignInRefusal {
  return {
    code: "oidc_sign_in_changed",
    message: `The identity for ${who} changed while the sign-in came back (deactivated, deleted or its link removed), so no session was issued. Sign in again.`,
    status: CONFLICT,
  };
}

function deactivated(name: string): SignInRefusal {
  return {
    code: "identity_deactivated",
    message: `${name} is deactivated, so it can't sign in. Ask an admin to reactivate it.`,
    status: FORBIDDEN,
  };
}

export {
  type SignInRefusal,
  deactivated,
  idTokenInvalid,
  nameTaken,
  emailNotAllowed,
  emailUnverified,
  issuerMismatch,
  nameUnusable,
  providerFailed,
  providerRefused,
  signInChanged,
  stateMismatch,
  stateMissing,
};
