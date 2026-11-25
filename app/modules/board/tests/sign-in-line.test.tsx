import { expect, it, onTestFinished, vi } from "vitest";
import type { BoardStore } from "../index.ts";
import type { CookoutClient } from "../../sdk/index.ts";
import { createBoardStore } from "../index.ts";
import { createComposer } from "../../composer/index.ts";
import { createCookoutClient } from "../../sdk/index.ts";
import { createLive } from "../../live/index.ts";
import { handLive } from "../../testing/web.ts";
import { webTestCookout } from "../../../../scripts/web-test-server.ts";

interface Viewing {
  readonly client: CookoutClient;
  readonly reads: () => number;
}

const NONE = { kind: "none" };
const ONE_READ = 1;

function clientWith(token: string): CookoutClient {
  return createCookoutClient({ env: {}, token, url: webTestCookout().url });
}

async function adminViewer(name: string): Promise<CookoutClient> {
  const admin = clientWith(webTestCookout().adminToken);
  const { token } = await admin.createIdentity({ kind: "human", name });
  await admin.makeAdmin(name);
  return clientWith(token);
}

function linkedWithoutLabel(viewer: CookoutClient): Viewing {
  let reads = 0;
  const signIn = vi.fn<CookoutClient["signIn"]>(viewer.signIn);
  signIn.mockRejectedValueOnce(new Error("unreachable"));
  async function getIdentity(name: string): ReturnType<CookoutClient["getIdentity"]> {
    const answer = await viewer.getIdentity(name);
    reads += ONE_READ;
    return { ...answer, signIn: { email: "ada@example.com", linkedAt: answer.identity.createdAt } };
  }
  return { client: { ...viewer, getIdentity, signIn }, reads: () => reads };
}

async function loggedInStore(client: CookoutClient, hand: ReturnType<typeof handLive>): Promise<BoardStore> {
  const store = createBoardStore({ client, live: createLive(hand.adapter), url: webTestCookout().url });
  onTestFinished(store.session.subscribe(vi.fn<() => void>()));
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({ signInWith: null, status: "logged-in" });
  });
  return store;
}

function reconnect(hand: ReturnType<typeof handLive>): void {
  hand.report("down");
  hand.report("up");
}

async function readOnce<Line>(viewing: Viewing, snapshot: () => Line): Promise<Line> {
  await vi.waitFor(() => {
    expect(viewing.reads()).toBe(ONE_READ);
  });
  return snapshot();
}

it("a linked profile read before the provider's name loads shows it once the name comes", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const { identity: profiled } = await clientWith(webTestCookout().adminToken).createIdentity({
    kind: "human",
    name: "board-sign-in-label-ada",
  });
  const viewing = linkedWithoutLabel(await adminViewer("board-sign-in-label-viewer"));
  const hand = handLive();
  const line = createComposer({ boardStore: await loggedInStore(viewing.client, hand) }).signIn(profiled.name);
  onTestFinished(line.subscribe(vi.fn<() => void>()));
  const before = await readOnce(viewing, line.snapshot);
  reconnect(hand);
  await vi.waitFor(() => {
    expect(line.snapshot()).toMatchObject({ email: "ada@example.com", kind: "linked", label: "single sign-on" });
  });

  expect(before).toStrictEqual(NONE);
});
