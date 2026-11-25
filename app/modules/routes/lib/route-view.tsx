import { AgentJoinApprovalView, Authors, LoginApprovalView, LoginView } from "../../views/index.tsx";
import type { Place, Route } from "../../paths/index.ts";
import { AppShell } from "../../design-system/layout.tsx";
import type { ReactNode } from "react";
import type { SignInRefusalCode } from "../../oidc/index.ts";
import { SignedInView } from "./signed-in-view.tsx";
import type { Stores } from "./stores.ts";
import { usePageTitle } from "../../page-title/index.ts";
import { useSyncExternalStore } from "react";

function signInRefusalOf(route: Route): SignInRefusalCode | null {
  if (route.name !== "login") {
    return null;
  }
  return route.signInRefusal;
}

function signInReturnFor(route: Route): string {
  if (route.name === "approve" || route.name === "approve-join") {
    return `#/${route.name}/${route.userCode}`;
  }
  if (route.name === "login") {
    return route.returnTo;
  }
  return "";
}

interface RouteViewProps {
  readonly place: Place;
  readonly stores: Stores;
}

export function RouteView(props: RouteViewProps): ReactNode {
  const {
    place: { profile, route },
    stores: { session },
  } = props;
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  usePageTitle({ board: props.stores.boardStore, route });
  if (state.status !== "logged-in") {
    return (
      <AppShell>
        <LoginView returnTo={signInReturnFor(route)} session={session} signInRefusal={signInRefusalOf(route)} />
      </AppShell>
    );
  }
  if (route.name === "approve") {
    return (
      <AppShell>
        <LoginApprovalView approval={props.stores.loginApprovals.forCode(route.userCode)} />
      </AppShell>
    );
  }
  if (route.name === "approve-join") {
    return (
      <AppShell>
        <AgentJoinApprovalView approval={props.stores.agentJoinApprovals.forCode(route.userCode)} />
      </AppShell>
    );
  }
  return (
    <Authors boardStore={props.stores.boardStore} keymap={props.stores.keymap}>
      <SignedInView identity={state.identity} profile={profile} route={route} stores={props.stores} />
    </Authors>
  );
}
