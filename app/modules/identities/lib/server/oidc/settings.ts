import { Function, Option } from "effect";
import type { Redacted } from "effect";
import { isPrivateHost } from "../adapters/provider-network.ts";
import { oidcCallbackPath } from "../../../../oidc/index.ts";

interface OidcSettings {
  readonly issuer: string;
  readonly client: string;
  readonly clientSecret: Option.Option<Redacted.Redacted>;
  readonly emailDomain: string;
  readonly label: string;
  readonly publicUrl: string;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isProviderUrl(text: string): boolean {
  if (!URL.canParse(text)) {
    return false;
  }
  const { hostname, protocol } = new URL(text);
  return protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
}

function hostnameOf(text: string): string {
  const parsed = Option.liftPredicate(text, (given) => URL.canParse(given));
  return Option.getOrElse(
    Option.map(parsed, (url) => new URL(url).hostname),
    Function.constant(""),
  );
}

function isLoopbackUrl(url: string): boolean {
  return LOOPBACK_HOSTS.has(hostnameOf(url));
}

function isProviderIssuer(issuer: string): boolean {
  return isProviderUrl(issuer) && (isLoopbackUrl(issuer) || !isPrivateHost(hostnameOf(issuer)));
}

function isEndpointOf(issuer: string): (url: string) => boolean {
  const loopbackIssuer = isLoopbackUrl(issuer);
  return (url) => isProviderUrl(url) && (loopbackIssuer || !isPrivateHost(hostnameOf(url)));
}

function originOf({ publicUrl }: OidcSettings): string {
  return new URL(publicUrl).origin;
}

function redirectUriOf(settings: OidcSettings): string {
  return `${originOf(settings)}${oidcCallbackPath}`;
}

export { type OidcSettings, isEndpointOf, isLoopbackUrl, isProviderIssuer, isProviderUrl, originOf, redirectUriOf };
export { oidcCallbackPath } from "../../../../oidc/index.ts";
