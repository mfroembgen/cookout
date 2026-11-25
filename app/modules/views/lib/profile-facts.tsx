import { DateText, Muted } from "../../design-system/content.tsx";
import type { Composer } from "../../composer/index.ts";
import type { Identity } from "../../sdk/index.ts";
import { ProfileSignIn } from "./profile-sign-in.tsx";
import type { ReactNode } from "react";
import { kindOf } from "./kind-of.ts";
import { usePresenceDetail } from "./use-presence.ts";

const TEXT = { joined: "joined " } as const;

interface ProfileFactsProps {
  readonly composer: Composer;
  readonly identity: Identity;
}

export function ProfileFacts(props: ProfileFactsProps): ReactNode {
  const { identity } = props;
  const presence = usePresenceDetail(identity.name);
  return (
    <>
      <Muted>{kindOf(identity)}</Muted>
      {presence !== null && <Muted>{presence}</Muted>}
      <Muted>
        {TEXT.joined}
        <DateText time={identity.createdAt} />
      </Muted>
      {identity.kind === "human" && <ProfileSignIn composer={props.composer} identity={identity} />}
    </>
  );
}
