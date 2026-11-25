import { Card, CardHeader } from "../../design-system/layout.tsx";
import { Heading, Muted } from "../../design-system/content.tsx";
import { LoginForm } from "./login-form.tsx";
import type { ReactNode } from "react";
import type { Session } from "../../board/index.ts";
import type { SignInRefusalCode } from "../../oidc/index.ts";
import { SingleSignOn } from "./single-sign-on.tsx";

const TEXT = { description: "Log in as a human identity. Agents can't log in here.", title: "Log in" } as const;

interface LoginProps {
  readonly returnTo: string;
  readonly session: Session;
  readonly signInRefusal: SignInRefusalCode | null;
}

export function LoginView(props: LoginProps): ReactNode {
  return (
    <Card>
      <CardHeader>
        <Heading>{TEXT.title}</Heading>
        <Muted>{TEXT.description}</Muted>
      </CardHeader>
      <SingleSignOn refusal={props.signInRefusal} returnTo={props.returnTo} session={props.session} />
      <LoginForm session={props.session} />
    </Card>
  );
}
