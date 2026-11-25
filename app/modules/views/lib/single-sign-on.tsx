import { Alert, Muted } from "../../design-system/content.tsx";
import { ButtonLink } from "../../design-system/controls.tsx";
import { CardBody } from "../../design-system/layout.tsx";
import type { ReactNode } from "react";
import type { Session } from "../../board/index.ts";
import type { SignInRefusalCode } from "../../oidc/index.ts";
import { signInStartHref } from "../../oidc/index.ts";
import { useSyncExternalStore } from "react";

const TEXT = { or: "Or log in with a human identity's token, such as the admin's." } as const;

const REFUSALS: Readonly<Record<SignInRefusalCode, string>> = {
  identity_deactivated: "Your identity on this board is deactivated. Ask an admin to reactivate it.",
  oidc_email_not_allowed: "Your email address isn't one this board lets in.",
  oidc_email_unverified: "The single sign-on provider doesn't say your email address is verified.",
  oidc_id_token_invalid: "The single sign-on provider's ID token didn't check out. Try again, or ask an admin.",
  oidc_issuer_mismatch: "The sign-in came back from another provider than this board's. Sign in again.",
  oidc_name_taken: "Your name is already on this board, so single sign-on can't make it for you. Ask an admin.",
  oidc_name_unusable: "Your email address can't become a name on this board. Ask an admin.",
  oidc_provider_failed: "The single sign-on provider didn't answer as it should. Try again, or ask an admin.",
  oidc_provider_refused: "The single sign-on provider didn't sign you in.",
  oidc_sign_in_changed: "Your identity changed while you signed in, so you weren't logged in. Sign in again.",
  oidc_state_mismatch: "The sign-in isn't the one this browser started. Sign in again.",
  oidc_state_missing: "The sign-in took longer than 10 minutes, or started in another browser. Sign in again.",
};

interface SingleSignOnProps {
  readonly refusal: SignInRefusalCode | null;
  readonly returnTo: string;
  readonly session: Session;
}

function refusalNotice(refusal: SignInRefusalCode | null): ReactNode {
  if (refusal === null) {
    return null;
  }
  return <Alert>{`Couldn't sign in (${refusal}): ${REFUSALS[refusal]}`}</Alert>;
}

export function SingleSignOn(props: SingleSignOnProps): ReactNode {
  const { refusal, returnTo, session } = props;
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  if (state.status !== "logged-out") {
    return null;
  }
  return (
    <>
      {state.signInWith !== null && (
        <CardBody>
          <ButtonLink href={signInStartHref({ back: returnTo, start: state.signInWith.start })}>
            {`Sign in with ${state.signInWith.label}`}
          </ButtonLink>
          <Muted>{TEXT.or}</Muted>
        </CardBody>
      )}
      {refusalNotice(refusal)}
    </>
  );
}
