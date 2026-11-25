import type { CookoutClient, Identity, Refusal } from "../../sdk/index.ts";
import { createCookoutClient, refusalOf } from "../../sdk/index.ts";
import type { Clock } from "../../format/index.ts";
import type { Identities } from "./identities-slice.ts";
import { browserClock } from "../../format/index.ts";

type SessionState =
  | { readonly status: "checking" }
  | { readonly status: "logged-out"; readonly refusal: Refusal | null; readonly signInWith: SignInOffer | null }
  | { readonly status: "logging-in" }
  | { readonly status: "logged-in"; readonly identity: Identity; readonly signInWith: SignInOffer | null };

interface SignInOffer {
  readonly label: string;
  readonly start: string;
}

type SessionClient = Pick<CookoutClient, "whoami" | "logout" | "signIn">;

interface SessionPart {
  readonly show: () => void;
  readonly hide: () => void;
  readonly back: () => void;
  readonly logIn: (token: string) => void;
  readonly logOut: () => void;
  readonly shown: (identities: Identities) => SessionState;
}

interface SessionPartOptions {
  readonly client: SessionClient;
  readonly clock: Clock | undefined;
  readonly url: string;
  readonly changed: () => void;
}

interface Answers {
  readonly check: () => Promise<void>;
  readonly logIn: (token: string) => Promise<void>;
  readonly logOut: () => Promise<void>;
}

interface SignInWith {
  readonly known: () => SignInOffer | null;
  readonly load: () => void;
}

interface Loading {
  readonly asked: number;
  readonly done: Promise<void>;
}

interface Labelling {
  readonly client: SessionClient;
  readonly clock: Clock;
  readonly held: Held;
}

interface Held {
  readonly state: () => SessionState;
  readonly put: (next: SessionState) => void;
}

interface Seen {
  readonly session: SessionState;
  readonly held: Identity | null;
  readonly shown: SessionState;
}

const NONE = 0;
const ONE = 1;
const NOT_LOGGED_IN = "token_missing";
const UNREACHABLE = "unreachable";
const CHECKING: SessionState = { status: "checking" };
const SIGN_IN_PATIENCE_MS = 5000;

function loadingAfter(loading: Loading | null, settled: number): Loading | null {
  if (loading === null || loading.asked === settled) {
    return null;
  }
  return loading;
}

function shownRefusal(refusal: Refusal): Refusal | null {
  if (refusal.code === NOT_LOGGED_IN) {
    return null;
  }
  return refusal;
}

function offerOf(answer: Awaited<ReturnType<SessionClient["signIn"]>>): SignInOffer | null {
  if (!answer.oidc) {
    return null;
  }
  return { label: answer.label, start: answer.start };
}

function labelledNow(held: Held, offer: SignInOffer | null): void {
  const current = held.state();
  if ((current.status === "logged-in" || current.status === "logged-out") && current.signInWith !== offer) {
    held.put({ ...current, signInWith: offer });
  }
}

async function answerOf(client: SessionClient): Promise<{ readonly offer: SignInOffer | null } | null> {
  try {
    return { offer: offerOf(await client.signIn()) };
  } catch {
    return null;
  }
}

function signInWithOf({ client, clock, held }: Labelling): SignInWith {
  let answered: { readonly offer: SignInOffer | null } | null = null;
  let loading: Loading | null = null;
  let asked = NONE;
  async function fetched(ask: number, stopWaiting: () => void): Promise<void> {
    const answer = await answerOf(client);
    stopWaiting();
    loading = loadingAfter(loading, ask);
    if (answer !== null && answered === null) {
      answered = answer;
      labelledNow(held, answer.offer);
    }
  }
  function load(): void {
    if (answered !== null || loading !== null) {
      return;
    }
    asked += ONE;
    const ask = asked;
    const stopWaiting = clock.after(SIGN_IN_PATIENCE_MS, () => {
      loading = loadingAfter(loading, ask);
    });
    loading = { asked: ask, done: fetched(ask, stopWaiting) };
  }
  function known(): SignInOffer | null {
    if (answered === null) {
      return null;
    }
    return answered.offer;
  }
  return { known, load };
}

function loggedOut(signInWith: SignInWith, refusal: Refusal | null): SessionState {
  return { refusal, signInWith: signInWith.known(), status: "logged-out" };
}

function loggedIn(signInWith: SignInWith, identity: Identity): SessionState {
  return { identity, signInWith: signInWith.known(), status: "logged-in" };
}

async function after(previous: Promise<void> | null, step: () => Promise<void>): Promise<void> {
  await previous;
  await step();
}

function labelling(held: Held, signInWith: SignInWith): Held {
  return {
    put: (next) => {
      held.put(next);
      signInWith.load();
    },
    state: held.state,
  };
}

function checkOf(
  held: Held,
  { client, signInWith }: { readonly client: SessionClient; readonly signInWith: SignInWith },
): () => Promise<void> {
  return async () => {
    try {
      const { identity } = await client.whoami();
      held.put(loggedIn(signInWith, identity));
    } catch (error: unknown) {
      const refusal = refusalOf(error);
      if (held.state().status !== "logged-in" || refusal.code !== UNREACHABLE) {
        held.put(loggedOut(signInWith, shownRefusal(refusal)));
      }
    }
  };
}

function answersOf(plain: Held, { client, clock, url }: Omit<SessionPartOptions, "changed">): Answers {
  const signInWith = signInWithOf({ client, clock: clock ?? browserClock, held: plain });
  const held = labelling(plain, signInWith);
  const check = checkOf(held, { client, signInWith });
  return {
    check,
    logIn: async (token) => {
      held.put({ status: "logging-in" });
      try {
        const { identity } = await createCookoutClient({ env: {}, token, url }).login();
        held.put(loggedIn(signInWith, identity));
      } catch (error: unknown) {
        held.put(loggedOut(signInWith, refusalOf(error)));
      }
    },
    logOut: async () => {
      try {
        await client.logout();
        held.put(loggedOut(signInWith, null));
      } catch {
        await check();
      }
    },
  };
}

function heldFor(session: SessionState, identities: Identities): Identity | null {
  if (session.status !== "logged-in") {
    return null;
  }
  return identities.listed.find((identity) => identity.name === session.identity.name) ?? null;
}

function shownOf(session: SessionState, held: Identity | null): SessionState {
  if (held === null || session.status !== "logged-in") {
    return session;
  }
  return { ...session, identity: held };
}

function loggedInOf(state: () => SessionState): (identities: Identities) => SessionState {
  let seen: Seen = { held: null, session: state(), shown: state() };
  return (identities) => {
    const session = state();
    const held = heldFor(session, identities);
    if (seen.session !== session || seen.held !== held) {
      seen = { held, session, shown: shownOf(session, held) };
    }
    return seen.shown;
  };
}

function createSessionPart(options: SessionPartOptions): SessionPart {
  let current = CHECKING;
  let readers = NONE;
  let queue: Promise<void> | null = null;
  const held: Held = {
    put: (next) => {
      current = next;
      options.changed();
    },
    state: () => current,
  };
  const { check, logIn, logOut } = answersOf(held, options);
  return {
    back: () => {
      if (readers > NONE) {
        queue = after(queue, check);
      }
    },
    hide: () => {
      readers -= ONE;
    },
    logIn: (token) => {
      queue = after(queue ?? check(), async () => {
        await logIn(token);
      });
    },
    logOut: () => {
      queue = after(queue, logOut);
    },
    show: () => {
      readers += ONE;
      queue ??= check();
    },
    shown: loggedInOf(held.state),
  };
}

export { type SessionClient, type SessionPart, type SessionPartOptions, type SessionState, createSessionPart };
