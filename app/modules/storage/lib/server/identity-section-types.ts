import type { IdentitiesSection } from "./identities.ts";
import type { LoginRequestsSection } from "./login-requests.ts";
import type { OfflineAlertsSection } from "./offline-alerts.ts";
import type { OidcLinksSection } from "./oidc-links.ts";
import type { PresenceSection } from "./presence.ts";
import type { TriggersSection } from "./triggers.ts";

export type SectionsBesideIdentities = LoginRequestsSection &
  PresenceSection &
  OfflineAlertsSection &
  TriggersSection &
  OidcLinksSection;

export type IdentitySections = IdentitiesSection & SectionsBesideIdentities;
