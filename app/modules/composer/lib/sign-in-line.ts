import { signInWith, viewerOf } from "../../board/index.ts";
import type { IdentityCalls } from "../../board/index.ts";
import type { IdentityName } from "../../sdk/index.ts";
import type { IdentityStore } from "./identity-list.ts";
import { listenersOf } from "./listeners.ts";

type SignIn = NonNullable<Awaited<ReturnType<IdentityCalls["readSignIn"]>>>;

type SignInLine = { readonly kind: "none" } | ({ readonly kind: "linked"; readonly label: string } & SignIn);

interface SignInLineStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => SignInLine;
}

interface SignInLineOptions {
  readonly calls: Pick<IdentityCalls, "readSignIn">;
  readonly store: Pick<IdentityStore, "snapshot" | "subscribeShowing">;
  readonly name: IdentityName;
  readonly show: () => () => void;
}

interface Shown {
  readonly label: string | null;
  readonly signIn: SignIn | null;
  readonly line: SignInLine;
}

interface Answer {
  readonly key: string;
  readonly signIn: SignIn | null;
}

interface Reading {
  readonly key: string;
  readonly done: Promise<void>;
}

const NONE: SignInLine = { kind: "none" };
const NO_READERS = 0;
const ONE = 1;
const UNREAD: Shown = { label: null, line: NONE, signIn: null };

function shownNow(shown: Shown, { label, signIn }: Omit<Shown, "line">): Shown {
  if (shown.signIn === signIn && shown.label === label) {
    return shown;
  }
  if (label === null || signIn === null) {
    return { label, line: NONE, signIn };
  }
  return { label, line: { ...signIn, kind: "linked", label }, signIn };
}

function keyOf(held: { readonly key: string } | null): string | null {
  if (held === null) {
    return null;
  }
  return held.key;
}

function signInFor(answer: Answer | null, key: string | null): SignIn | null {
  if (answer === null || answer.key !== key) {
    return null;
  }
  return answer.signIn;
}

async function answerOf(options: SignInLineOptions): Promise<{ readonly signIn: SignIn | null } | null> {
  try {
    return { signIn: await options.calls.readSignIn(options.name) };
  } catch {
    return null;
  }
}

function readingWithout(reading: Reading | null, key: string): Reading | null {
  if (keyOf(reading) === key) {
    return null;
  }
  return reading;
}

interface ReadKeys {
  readonly now: () => string | null;
  readonly viewerChanged: () => void;
  readonly closed: (readers: number) => void;
}

function readKeysOf(store: SignInLineOptions["store"]): ReadKeys {
  let opening = NO_READERS;
  let seen = viewerOf(store.snapshot());
  return {
    closed: (readers) => {
      opening += Number(readers === NO_READERS);
    },
    now: () => {
      const current = viewerOf(store.snapshot());
      if (current === null) {
        return null;
      }
      return `${opening}:${current}`;
    },
    viewerChanged: () => {
      const current = viewerOf(store.snapshot());
      opening += Number(current !== seen);
      seen = current;
    },
  };
}

function createSignInLine(options: SignInLineOptions): SignInLineStore {
  const { store } = options;
  const listeners = listenersOf(options.show);
  const keys = readKeysOf(store);
  let answer: Answer | null = null;
  let reading: Reading | null = null;
  let shown = UNREAD;
  let readers = NO_READERS;

  async function readFor(key: string): Promise<void> {
    const answered = await answerOf(options);
    reading = readingWithout(reading, key);
    if (answered !== null && key === keys.now()) {
      answer = { key, signIn: answered.signIn };
      listeners.notify();
    }
  }

  function read(): void {
    const key = keys.now();
    if (readers === NO_READERS || key === null || keyOf(answer) === key || keyOf(reading) === key) {
      return;
    }
    reading = { done: readFor(key), key };
  }

  return {
    snapshot: () => {
      shown = shownNow(shown, { label: signInWith(store.snapshot()), signIn: signInFor(answer, keys.now()) });
      return shown.line;
    },
    subscribe: (listener) => {
      readers += ONE;
      read();
      const stopListening = listeners.add(listener);
      const stopSession = store.subscribeShowing("session")(() => {
        keys.viewerChanged();
        read();
        listener();
      });
      return () => {
        readers -= ONE;
        keys.closed(readers);
        stopSession();
        stopListening();
      };
    },
  };
}

export { type SignInLineStore, createSignInLine };
