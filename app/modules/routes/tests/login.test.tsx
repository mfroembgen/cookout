import { adminClient, anonymousClient, newIdentity, sessionOf } from "./identities.ts";
import { alertSaying, alertsShown } from "./alerts.ts";
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { inPane, inSidebar } from "./regions.ts";
import type { SignInResponse } from "../../oidc/index.ts";
import { openAt } from "./render.tsx";
import { unreachableClient } from "../../testing/index.ts";

function logInWith(token: string): void {
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: token } });
  fireEvent.click(inPane().getByRole("button", { name: "Log in" }));
}

async function refusalShownFor(token: string): Promise<readonly unknown[]> {
  const close = openAt({ client: anonymousClient(), hash: "#/" });
  await screen.findByRole("form", { name: "Log in" });
  logInWith(token);
  const alert = await alertSaying("Couldn't log in");
  const shown = [alert.textContent, screen.queryByRole("list", { name: "Views" })];
  close();
  return shown;
}

it("with no session, every route shows the login form and no refusal", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const close = openAt({ client: anonymousClient(), hash: "#/channels/general" });

  const form = await screen.findByRole("form", { name: "Log in" });

  expect([form.textContent, alertsShown()]).toStrictEqual(["TokenLog in", []]);

  close();
});

it("a login started before the app is drawn still lands on the channel list", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  await adminClient().createChannel({ name: "web-login-early" });
  const human = await newIdentity({ kind: "human", name: "web-login-early-human" });
  const session = sessionOf(anonymousClient());
  session.logIn(human.token);
  const close = openAt({ client: human.client, hash: "#/", session });

  const link = await inSidebar().findByRole("link", { name: "#web-login-early" });

  expect(link.getAttribute("href")).toBe("#/channels/web-login-early");

  close();
});

it("logging in with a human token shows the channel list", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  await adminClient().createChannel({ name: "web-login-lands-here" });
  const human = await newIdentity({ kind: "human", name: "web-login-human" });
  const session = sessionOf(anonymousClient());
  const close = openAt({ client: human.client, hash: "#/", session });
  await screen.findByRole("form", { name: "Log in" });

  logInWith(human.token);
  const link = await inSidebar().findByRole("link", { name: "#web-login-lands-here" });

  expect(link.getAttribute("href")).toBe("#/channels/web-login-lands-here");

  close();
});

it("logging in with an agent's token is refused with human_only", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const { token } = await newIdentity({ kind: "agent", name: "web-login-agent" });

  await expect(refusalShownFor(token)).resolves.toStrictEqual([
    "Couldn't log in (human_only): Only a human identity can log in to the web UI, and web-login-agent is an agent.",
    null,
  ]);
});

it("logging in with a token that was rotated away is refused with token_revoked", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const { token } = await newIdentity({ kind: "human", name: "web-login-rotated" });
  await adminClient().rotateToken("web-login-rotated");

  await expect(refusalShownFor(token)).resolves.toStrictEqual([
    expect.stringMatching(/^Couldn't log in \(token_revoked\)/u),
    null,
  ]);
});

it("the login route says who is logged in", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const { client } = await newIdentity({ kind: "human", name: "web-login-who" });
  const close = openAt({ client, hash: "#/login" });

  const link = await inPane().findByRole("link", { name: "Logged in as @web-login-who. See the inbox" });

  expect(link.getAttribute("href")).toBe("#/inbox");

  close();
});

it("the login view says so when the server can't be reached", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const client = unreachableClient();
  const close = openAt({ client, hash: "#/" });

  const alert = await alertSaying("Couldn't log in");

  expect(alert.textContent).toMatch(/^Couldn't log in \(unreachable\)/u);

  close();
});

it("with single sign-on on, the login view links to it above the token form", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const close = openAt({ client: anonymousClient(), hash: "#/" });

  const link = await inPane().findByRole("link", { name: "Sign in with single sign-on" });
  const form = inPane().getByRole("form", { name: "Log in" });

  expect([link.getAttribute("href"), form.textContent]).toStrictEqual([
    "https://board.example.com/v1/oidc/start",
    "TokenLog in",
  ]);

  close();
});

async function signInHrefAt(hash: string): Promise<string | null> {
  const close = openAt({ client: anonymousClient(), hash });
  const link = await inPane().findByRole("link", { name: "Sign in with single sign-on" });
  close();
  return link.getAttribute("href");
}

async function publicStartAt(hash: string): Promise<string | null> {
  const elsewhere = "https://public.example.org/v1/oidc/start";
  const client = {
    ...anonymousClient(),
    signIn: async (): Promise<SignInResponse> => {
      await Promise.resolve();
      return { label: "single sign-on", oidc: true, start: elsewhere };
    },
  };
  const close = openAt({ client, hash });
  const link = await inPane().findByRole("link", { name: "Sign in with single sign-on" });
  close();
  return link.getAttribute("href");
}

it("single sign-on starts at the start URL the server names, whatever address the page was opened on", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const hrefs = [await publicStartAt("#/"), await publicStartAt("#/approve/ABCD-1234")];

  expect([globalThis.location.origin === "https://public.example.org", ...hrefs]).toStrictEqual([
    false,
    "https://public.example.org/v1/oidc/start",
    "https://public.example.org/v1/oidc/start?return=%23%2Fapprove%2FABCD-1234",
  ]);
});

it("signed out on an approval page, single sign-on comes back to that page", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const hrefs = [await signInHrefAt("#/approve/ABCD-1234"), await signInHrefAt("#/approve-join/WXYZ-9876")];

  expect(hrefs).toStrictEqual([
    "https://board.example.com/v1/oidc/start?return=%23%2Fapprove%2FABCD-1234",
    "https://board.example.com/v1/oidc/start?return=%23%2Fapprove-join%2FWXYZ-9876",
  ]);
});

it("a sign-in refused after starting from an approval page signs in again back to that page", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const close = openAt({ client: anonymousClient(), hash: "#/login/oidc_provider_refused/approve/ABCD-1234" });
  const link = await inPane().findByRole("link", { name: "Sign in with single sign-on" });
  const alert = await alertSaying("Couldn't sign in");

  expect([link.getAttribute("href"), alert.textContent]).toStrictEqual([
    "https://board.example.com/v1/oidc/start?return=%23%2Fapprove%2FABCD-1234",
    "Couldn't sign in (oidc_provider_refused): The single sign-on provider didn't sign you in.",
  ]);

  close();
});

it("a refused sign-in says why on the login view, with the link to sign in again", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const close = openAt({ client: anonymousClient(), hash: "#/login/oidc_email_not_allowed" });

  const alert = await alertSaying("Couldn't sign in");
  const link = await inPane().findByRole("link", { name: "Sign in with single sign-on" });

  expect([alert.textContent, link]).toStrictEqual([
    "Couldn't sign in (oidc_email_not_allowed): Your email address isn't one this board lets in.",
    expect.anything(),
  ]);

  close();
});

it("the login view has no single sign-on link when the server can't be reached", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const close = openAt({ client: unreachableClient(), hash: "#/login/no_such_code" });

  await alertSaying("Couldn't log in");

  expect([inPane().queryByRole("link", { name: "Sign in with single sign-on" }), alertsShown()]).toStrictEqual([
    null,
    [expect.stringMatching(/^Couldn't log in \(unreachable\)/u)],
  ]);

  close();
});
