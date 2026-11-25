import { expect, it, onTestFinished, vi } from "vitest";
import type { Clock } from "../../format/index.ts";
import type { CookoutClient } from "../../sdk/index.ts";
import { createBoardStore } from "../index.ts";
import { createCookoutClient } from "../../sdk/index.ts";
import { webTestCookout } from "../../../../scripts/web-test-server.ts";

const ASKED_TWICE = 2;
const ONCE = 1;
const NONE_DUE = 0;
const NO_WAIT = 0;

it("a sign-in answer that failed is asked again at the next session change", { timeout: 5000 }, async () => {
  expect.hasAssertions();

  const client = createCookoutClient({ env: {}, url: webTestCookout().url });
  const signIn = vi.fn<CookoutClient["signIn"]>(client.signIn);
  signIn.mockRejectedValueOnce(new Error("unreachable"));
  const store = createBoardStore({ client: { ...client, signIn }, live: null, url: webTestCookout().url });
  onTestFinished(store.session.subscribe(vi.fn<() => void>()));
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({ signInWith: null, status: "logged-out" });
  });
  store.session.logIn("cookout_not-a-token");
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({
      refusal: { code: "token_unknown" },
      signInWith: { label: "single sign-on" },
    });
  });

  expect(signIn).toHaveBeenCalledTimes(ASKED_TWICE);
});

it("a sign-in answer that never comes doesn't hold up the logged-out session and its token form", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const client = createCookoutClient({ env: {}, url: webTestCookout().url });
  const { promise: never } = Promise.withResolvers<Awaited<ReturnType<CookoutClient["signIn"]>>>();
  const store = createBoardStore({
    client: {
      ...client,
      signIn: async () => {
        const answer = await never;
        return answer;
      },
    },
    live: null,
    url: webTestCookout().url,
  });
  onTestFinished(store.session.subscribe(vi.fn<() => void>()));

  await vi.waitFor(() => {
    expect(store.session.snapshot()).toStrictEqual({ refusal: null, signInWith: null, status: "logged-out" });
  });
});

interface HandClock {
  readonly clock: Clock;
  readonly passed: () => void;
}

function handClock(): HandClock {
  const due: (() => void)[] = [];
  return {
    clock: {
      after: (_millis, listener) => {
        due.push(listener);
        return () => {
          due.splice(due.indexOf(listener), ONCE);
        };
      },
    },
    passed: () => {
      for (const listener of due.splice(NONE_DUE)) {
        listener();
      }
    },
  };
}

interface Hanging {
  readonly answerLate: (label: string) => void;
  readonly hand: HandClock;
  readonly signIn: ReturnType<typeof vi.fn<CookoutClient["signIn"]>>;
  readonly store: ReturnType<typeof createBoardStore>;
}

function firstSignInHanging(): Hanging {
  const client = createCookoutClient({ env: {}, url: webTestCookout().url });
  const late = Promise.withResolvers<Awaited<ReturnType<CookoutClient["signIn"]>>>();
  const signIn = vi.fn<CookoutClient["signIn"]>(client.signIn).mockReturnValueOnce(late.promise);
  const hand = handClock();
  const { url } = webTestCookout();
  const store = createBoardStore({ client: { ...client, signIn }, clock: hand.clock, live: null, url });
  onTestFinished(store.session.subscribe(vi.fn<() => void>()));
  return {
    answerLate: (label) => {
      late.resolve({ label, oidc: true, start: "https://board.example.com/v1/oidc/start" });
    },
    hand,
    signIn,
    store,
  };
}

it("a sign-in answer still unsettled after a while is asked once more at the next session change, and that answer labels the form", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const { hand, signIn, store } = firstSignInHanging();
  await vi.waitFor(() => {
    expect(signIn).toHaveBeenCalledTimes(ONCE);
  });
  hand.passed();
  store.session.logIn("cookout_not-a-token");
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({
      refusal: { code: "token_unknown" },
      signInWith: { label: "single sign-on" },
    });
  });

  expect(signIn).toHaveBeenCalledTimes(ASKED_TWICE);
});

async function everythingSettled(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  globalThis.setTimeout(() => {
    resolve(true);
  }, NO_WAIT);
  await promise;
}

it("a timed-out sign-in answer that comes after a newer one doesn't replace the newer label", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const { answerLate, hand, signIn, store } = firstSignInHanging();
  await vi.waitFor(() => {
    expect(signIn).toHaveBeenCalledTimes(ONCE);
  });
  hand.passed();
  store.session.logIn("cookout_not-a-token");
  await vi.waitFor(() => {
    expect(store.session.snapshot()).toMatchObject({ signInWith: { label: "single sign-on" } });
  });
  answerLate("an older provider");
  await everythingSettled();

  expect(store.session.snapshot()).toMatchObject({
    refusal: { code: "token_unknown" },
    signInWith: { label: "single sign-on" },
  });
});

it("a timed-out sign-in answer that comes while a newer request is out labels the form, and the newer one changes nothing", {
  timeout: 5000,
}, async () => {
  expect.hasAssertions();

  const { answerLate, hand, signIn, store } = firstSignInHanging();
  await vi.waitFor(() => {
    expect(signIn).toHaveBeenCalledTimes(ONCE);
  });
  hand.passed();
  store.session.logIn("cookout_not-a-token");
  answerLate("an older provider");
  await vi.waitFor(() => {
    expect(signIn).toHaveBeenCalledTimes(ASKED_TWICE);
    expect(store.session.snapshot()).toMatchObject({ refusal: { code: "token_unknown" } });
  });
  await everythingSettled();

  expect(store.session.snapshot()).toMatchObject({ signInWith: { label: "an older provider" } });
});
