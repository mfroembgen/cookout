import { DateText, Muted } from "../../design-system/content.tsx";
import { useMemo, useSyncExternalStore } from "react";
import type { Composer } from "../../composer/index.ts";
import type { Identity } from "../../sdk/index.ts";
import type { ReactNode } from "react";

const TEXT = { linked: " · linked ", signsIn: "Signs in with " } as const;

interface ProfileSignInProps {
  readonly composer: Composer;
  readonly identity: Identity;
}

export function ProfileSignIn(props: ProfileSignInProps): ReactNode {
  const { composer, identity } = props;
  const store = useMemo(() => composer.signIn(identity.name), [composer, identity.name]);
  const line = useSyncExternalStore(store.subscribe, store.snapshot);
  if (line.kind === "none") {
    return null;
  }
  return (
    <Muted>
      {`${TEXT.signsIn}${line.label} · ${line.email}${TEXT.linked}`}
      <DateText time={line.linkedAt} />
    </Muted>
  );
}
