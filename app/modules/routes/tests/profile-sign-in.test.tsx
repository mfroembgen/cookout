import type { CookoutClient, IdentityName } from "../../sdk/index.ts";
import { act, within } from "@testing-library/react";
import { adminClient, newIdentity } from "./identities.ts";
import { expect, it, onTestFinished, vi } from "vitest";
import type { BoardStore } from "../../board/index.ts";
import type { Composer } from "../../composer/index.ts";
import { createBoardStore } from "../../board/index.ts";
import { createComposer } from "../../composer/index.ts";
import { inProfile } from "./regions.ts";
import { openAt } from "./render.tsx";
import { webTestCookout } from "../../../../scripts/web-test-server.ts";

const START = 0;
const DATE_LENGTH = "2026-01-01".length;

type ProfileShown = (name: string) => Promise<readonly unknown[]>;

function profileReadWith(client: CookoutClient, answer: CookoutClient["getIdentity"]): ProfileShown {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const reading: CookoutClient = {
    ...client,
    getIdentity: async (name) => {
      const answered = answer(name);
      resolve(await answered.catch((error: unknown) => error));
      return answered;
    },
  };
  return async (name) => {
    const close = openAt({ client: reading, hash: `#/inbox?profile=${name}` });
    await inProfile().findByRole("heading", { level: 3 });
    await act(async () => {
      await promise;
    });
    const shown: (string | null)[] = [];
    for (const line of within(inProfile().element()).queryAllByText(/^Signs in with/u)) {
      shown.push(line.textContent);
    }
    close();
    return shown;
  };
}

it("a linked human's own profile says how it signs in: the provider, the verified email and when it was linked", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const ada = await newIdentity({ kind: "human", name: "web-sign-in-linked" });
  const { identity } = await ada.client.whoami();
  const signIn = { email: "ada@example.com", linkedAt: identity.createdAt };
  const shown = profileReadWith(ada.client, async (name) => ({ ...(await ada.client.getIdentity(name)), signIn }));
  const date = identity.createdAt.slice(START, DATE_LENGTH);

  await expect(shown("web-sign-in-linked")).resolves.toStrictEqual([
    `Signs in with single sign-on · ada@example.com · linked ${date}`,
  ]);
});

it("an unlinked profile says nothing, your own or another's", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const ada = await newIdentity({ kind: "human", name: "web-sign-in-unlinked" });
  const other = await newIdentity({ kind: "human", name: "web-sign-in-other" });
  const own = await profileReadWith(ada.client, ada.client.getIdentity)("web-sign-in-unlinked");
  const others = await profileReadWith(other.client, other.client.getIdentity)("web-sign-in-unlinked");

  expect([own, others]).toStrictEqual([[], []]);
});

it("with single sign-on off, or the profile's identity unreadable, there's no sign-in line", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const ada = await newIdentity({ kind: "human", name: "web-sign-in-off" });
  const off: CookoutClient = {
    ...ada.client,
    signIn: async () => {
      await Promise.resolve();
      return { oidc: false };
    },
  };
  const unreadable = profileReadWith(ada.client, async () => {
    await Promise.resolve();
    throw new Error("unreachable");
  });

  await expect(profileReadWith(off, ada.client.getIdentity)("web-sign-in-off")).resolves.toStrictEqual([]);
  await expect(unreadable("web-sign-in-off")).resolves.toStrictEqual([]);
});

interface Viewing {
  readonly client: CookoutClient;
  readonly reads: () => number;
  readonly asks: () => number;
}

interface Scene {
  readonly composer: Composer;
  readonly store: BoardStore;
  readonly viewing: Viewing;
  readonly profiled: IdentityName;
  readonly viewer: Awaited<ReturnType<typeof newIdentity>>;
}

const FIRST_READ = 1;
const SECOND_READ = 2;
const NONE = { kind: "none" };

function viewingAs(viewer: CookoutClient, gate: Promise<unknown>, failFirst = false): Viewing {
  let reads = 0;
  let asks = 0;
  return {
    asks: () => asks,
    client: {
      ...viewer,
      getIdentity: async (name) => {
        asks += FIRST_READ;
        if (failFirst && asks === FIRST_READ) {
          throw new Error("unreachable");
        }
        const { identity } = await viewer.whoami();
        await gate;
        const answer = await viewer.getIdentity(name);
        reads += FIRST_READ;
        if (!identity.admin) {
          return answer;
        }
        return { ...answer, signIn: { email: "ada@example.com", linkedAt: answer.identity.createdAt } };
      },
    },
    reads: () => reads,
  };
}

async function viewedAs(store: BoardStore, status: "logged-in" | "logged-out"): Promise<void> {
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({ status });
  });
}

async function adminViewing(prefix: string, gate: Promise<unknown>, failFirst = false): Promise<Scene> {
  const ada = await newIdentity({ kind: "human", name: `${prefix}-ada` });
  const viewer = await newIdentity({ kind: "human", name: `${prefix}-viewer` });
  await adminClient().makeAdmin(`${prefix}-viewer`);
  const { identity: profiled } = await ada.client.whoami();
  const viewing = viewingAs(viewer.client, gate, failFirst);
  const store = createBoardStore({ client: viewing.client, live: null, url: webTestCookout().url });
  onTestFinished(store.session.subscribe(vi.fn<() => void>()));
  await viewedAs(store, "logged-in");
  return { composer: createComposer({ boardStore: store }), profiled: profiled.name, store, viewer, viewing };
}

async function readsDone(scene: Scene, reads: number): Promise<void> {
  await vi.waitFor(() => {
    expect(scene.viewing.reads()).toBe(reads);
  });
}

async function demotedElsewhere({ store, viewer }: Scene, prefix: string): Promise<void> {
  store.session.logOut();
  await viewedAs(store, "logged-out");
  await adminClient().removeAdmin(`${prefix}-viewer`);
  store.session.logIn(viewer.token);
  await viewedAs(store, "logged-in");
}

function shownLine(scene: Scene): ReturnType<Composer["signIn"]> {
  const line = scene.composer.signIn(scene.profiled);
  onTestFinished(line.subscribe(vi.fn<() => void>()));
  return line;
}

it("an open profile's line goes when its admin viewer is logged in again without admin, and isn't read back as theirs", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const scene = await adminViewing("web-sign-in-demoted", Promise.resolve());
  const line = shownLine(scene);
  await vi.waitFor(() => {
    expect(line.snapshot()).toMatchObject({ email: "ada@example.com", kind: "linked" });
  });
  await demotedElsewhere(scene, "web-sign-in-demoted");
  await readsDone(scene, SECOND_READ);

  expect(line.snapshot()).toStrictEqual(NONE);
});

it("an admin's read that answers after the viewer lost admin is dropped", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const { promise: gate, resolve: answerNow } = Promise.withResolvers<boolean>();
  const scene = await adminViewing("web-sign-in-late", gate);
  const line = shownLine(scene);
  await demotedElsewhere(scene, "web-sign-in-late");
  answerNow(true);
  await readsDone(scene, SECOND_READ);

  expect(line.snapshot()).toStrictEqual(NONE);
});

it("an answer that comes after its profile closed is dropped", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const { promise: gate, resolve: answerNow } = Promise.withResolvers<boolean>();
  const scene = await adminViewing("web-sign-in-closed", gate);
  const line = scene.composer.signIn(scene.profiled);
  line.subscribe(vi.fn<() => void>())();
  answerNow(true);
  await readsDone(scene, FIRST_READ);

  expect(line.snapshot()).toStrictEqual(NONE);
});

it("a profile read that failed is read again the next time the profile shows", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const scene = await adminViewing("web-sign-in-retry", Promise.resolve(), true);
  const line = scene.composer.signIn(scene.profiled);
  const hide = line.subscribe(vi.fn<() => void>());
  await vi.waitFor(() => {
    expect(scene.viewing.asks()).toBe(FIRST_READ);
  });
  hide();
  onTestFinished(line.subscribe(vi.fn<() => void>()));
  await vi.waitFor(() => {
    expect(line.snapshot()).toMatchObject({ email: "ada@example.com", kind: "linked" });
  });

  expect(scene.viewing.asks()).toBe(SECOND_READ);
});
