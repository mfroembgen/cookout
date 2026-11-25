import { Array as Arr, Effect, Option, pipe } from "effect";
import type {
  CollectLoginRequest,
  IssueLoginCredential,
  LoginCollection,
  LoginRequest,
  LoginRequestsSection,
  NewLoginRequest,
} from "./login-requests.ts";
import { GONE, PENDING, collected } from "./login-requests.ts";
import type { Identity, IdentityName, TokenHash } from "../../../identities/index.ts";
import type { Fails } from "./errors.ts";
import type { FindIdentity } from "./identity-row.ts";
import type { IsoTime } from "../../../time/index.ts";
import type { MemoryState } from "./memory-state.ts";

interface MemoryRequest {
  readonly request: NewLoginRequest;
  readonly approvedBy: Option.Option<IdentityName>;
}

type Requests = Map<TokenHash, MemoryRequest>;

type LoginCredentials = Map<TokenHash, IdentityName>;

interface MemoryLoginRequestsOptions {
  readonly findIdentity: FindIdentity;
  readonly state: MemoryState;
}

interface Held {
  readonly credentials: LoginCredentials;
  readonly findIdentity: FindIdentity;
}

type MemoryLoginRequestsSection = LoginRequestsSection & {
  readonly dropLoginCredentials: (name: IdentityName) => Effect.Effect<void>;
  readonly issueCredentialNow: (given: IssueLoginCredential) => Identity | undefined;
};

function shown({ approvedBy, request }: MemoryRequest): LoginRequest {
  const { expiresAt, host, userCode } = request;
  return { approved: Option.isSome(approvedBy), expiresAt, host, userCode };
}

function dropExpired(requests: Requests, now: IsoTime): void {
  for (const [hash, { request }] of requests) {
    if (now >= request.expiresAt) {
      requests.delete(hash);
    }
  }
}

function liveByCode(requests: Requests, userCode: string, now: IsoTime): Option.Option<MemoryRequest> {
  dropExpired(requests, now);
  return Arr.findFirst([...requests.values()], ({ request }) => request.userCode === userCode);
}

function dropCredentialsOf(credentials: LoginCredentials, name: IdentityName): void {
  for (const [hash, holder] of credentials) {
    if (holder === name) {
      credentials.delete(hash);
    }
  }
}

function dropApprovedBy(requests: Requests, name: IdentityName): void {
  for (const [hash, { approvedBy }] of requests) {
    if (Option.exists(approvedBy, (approver) => approver === name)) {
      requests.delete(hash);
    }
  }
}

function identityOf(held: Held, name: IdentityName): Option.Option<Identity> {
  return Option.map(Option.fromUndefinedOr(held.findIdentity(name)), (found) => ({ ...found }));
}

function collectFrom(requests: Requests, held: Held) {
  return ({ credentialHash, now, requestHash }: CollectLoginRequest): LoginCollection => {
    dropExpired(requests, now);
    const found = Option.fromUndefinedOr(requests.get(requestHash));
    if (Option.isNone(found)) {
      return GONE;
    }
    if (Option.isNone(found.value.approvedBy)) {
      return PENDING;
    }
    requests.delete(requestHash);
    const identity = identityOf(held, found.value.approvedBy.value);
    return Option.match(identity, {
      onNone: () => GONE,
      onSome: (approver) => {
        held.credentials.set(credentialHash, approver.name);
        return collected(approver);
      },
    });
  };
}

function approveIn(requests: Requests) {
  return (userCode: string, approver: IdentityName, now: IsoTime): "approved" | "not_found" =>
    Option.match(liveByCode(requests, userCode, now), {
      onNone: () => "not_found",
      onSome: ({ approvedBy, request }) => {
        requests.set(request.requestHash, { approvedBy: Option.orElseSome(approvedBy, () => approver), request });
        return "approved";
      },
    });
}

function addTo(requests: Requests) {
  return (request: NewLoginRequest, now: IsoTime): "added" | "code_taken" => {
    if (Option.isSome(liveByCode(requests, request.userCode, now))) {
      return "code_taken";
    }
    requests.set(request.requestHash, { approvedBy: Option.none(), request: { ...request } });
    return "added";
  };
}

function open<Value>(state: MemoryState, work: () => Value): Fails<Value> {
  return Effect.andThen(state.ensureOpen, Effect.sync(work));
}

function findCredentialIn(held: Held) {
  return (hash: TokenHash): Identity | undefined =>
    pipe(
      Option.fromUndefinedOr(held.credentials.get(hash)),
      Option.flatMap((name) => identityOf(held, name)),
      Option.getOrUndefined,
    );
}

function issueStraightTo(held: Held) {
  return ({ credentialHash, identity }: IssueLoginCredential): Identity | undefined =>
    pipe(
      identityOf(held, identity),
      Option.map((found) => {
        held.credentials.set(credentialHash, found.name);
        return found;
      }),
      Option.getOrUndefined,
    );
}

function memoryLoginRequests({ findIdentity, state }: MemoryLoginRequestsOptions): MemoryLoginRequestsSection {
  const requests: Requests = new Map();
  const held: Held = { credentials: new Map(), findIdentity };
  const approve = approveIn(requests);
  const add = addTo(requests);
  const collect = collectFrom(requests, held);
  const findCredential = findCredentialIn(held);
  const issue = issueStraightTo(held);
  return {
    addLoginRequest: (request, now) => open(state, () => add(request, now)),
    approveLoginRequest: (userCode, approver, now) => open(state, () => approve(userCode, approver, now)),
    collectLoginRequest: (given) => open(state, () => collect(given)),
    dropLoginCredentials: (name) =>
      Effect.sync(() => {
        dropCredentialsOf(held.credentials, name);
        dropApprovedBy(requests, name);
      }),
    findLoginCredential: (hash) => open(state, () => findCredential(hash)),
    findLoginRequest: (userCode, now) =>
      open(state, () => pipe(liveByCode(requests, userCode, now), Option.map(shown), Option.getOrUndefined)),
    issueCredentialNow: issue,
    issueLoginCredential: (given) => open(state, () => issue(given)),
    revokeLoginCredential: (hash) => open(state, () => held.credentials.delete(hash)),
  };
}

export { memoryLoginRequests };
