import { Agent, Dispatcher1Wrapper } from "undici";
import { Array as Arr, Function, Option, Predicate, String as Str, pipe } from "effect";
import { BlockList, isIP } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { lookup } from "node:dns";

interface Subnet {
  readonly network: string;
  readonly prefix: number;
  readonly family: "ipv4" | "ipv6";
}

type Resolved = (failure: Readonly<Error> | null, addresses?: readonly Readonly<LookupAddress>[]) => void;

type Resolve = (hostname: string, resolved: Resolved) => void;

interface GuardedInit extends RequestInit {
  readonly dispatcher: Dispatcher1Wrapper;
}

const IPV4 = 4;
const NOT_AN_ADDRESS = 0;
const HEX = 16;
const BYTE = 256;
const ZONE = "%";
const EMBEDDED_IPV4 = /^\[::(?:ffff:)?(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})\]$/u;
const GLOBAL_UNICAST_PREFIX = 3;
const BRACKETS = /^\[|\]$/gu;
const TRAILING_DOTS = /\.+$/u;
const LOCALHOST = "localhost";
const MAX_CAUSES = 6;
const NO_CAUSES = 0;
const ONE_CAUSE = 1;
const UNDER_LOCALHOST = ".localhost";

const NOT_GLOBAL_IPV4: readonly Subnet[] = [
  { family: "ipv4", network: "0.0.0.0", prefix: 8 },
  { family: "ipv4", network: "10.0.0.0", prefix: 8 },
  { family: "ipv4", network: "100.64.0.0", prefix: 10 },
  { family: "ipv4", network: "127.0.0.0", prefix: 8 },
  { family: "ipv4", network: "169.254.0.0", prefix: 16 },
  { family: "ipv4", network: "172.16.0.0", prefix: 12 },
  { family: "ipv4", network: "192.0.0.0", prefix: 24 },
  { family: "ipv4", network: "192.0.2.0", prefix: 24 },
  { family: "ipv4", network: "192.88.99.0", prefix: 24 },
  { family: "ipv4", network: "192.168.0.0", prefix: 16 },
  { family: "ipv4", network: "198.18.0.0", prefix: 15 },
  { family: "ipv4", network: "198.51.100.0", prefix: 24 },
  { family: "ipv4", network: "203.0.113.0", prefix: 24 },
  { family: "ipv4", network: "224.0.0.0", prefix: 4 },
  { family: "ipv4", network: "240.0.0.0", prefix: 4 },
  { family: "ipv6", network: "2001::", prefix: 23 },
  { family: "ipv6", network: "2001:db8::", prefix: 32 },
  { family: "ipv6", network: "2002::", prefix: 16 },
  { family: "ipv6", network: "3fff::", prefix: 20 },
];

const notGlobal = new BlockList();
for (const { family, network, prefix } of NOT_GLOBAL_IPV4) {
  notGlobal.addSubnet(network, prefix, family);
}

const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", GLOBAL_UNICAST_PREFIX, "ipv6");

function dottedOf(high: string, low: string): string {
  const [first, second] = [Number.parseInt(high, HEX), Number.parseInt(low, HEX)];
  const bytes = [Math.floor(first / BYTE), first % BYTE, Math.floor(second / BYTE), second % BYTE];
  return Arr.join(Arr.map(bytes, String), ".");
}

function embeddedIpv4(address: string): Option.Option<string> {
  const canonical = new URL(`http://[${address}]`).hostname;
  const halves = Option.liftPredicate(Str.replace(EMBEDDED_IPV4, "$<high> $<low>")(canonical), () =>
    EMBEDDED_IPV4.test(canonical),
  );
  return Option.map(halves, (pair) => {
    const [high, low = ""] = Str.split(" ")(pair);
    return dottedOf(high, low);
  });
}

function isNotGlobalIpv6(address: string): boolean {
  return !globalUnicast.check(address, "ipv6") || notGlobal.check(address, "ipv6");
}

function isPrivateAddress(given: string): boolean {
  const [address] = Str.split(ZONE)(given);
  if (isIP(address) === IPV4) {
    return notGlobal.check(address, "ipv4");
  }
  return Option.match(embeddedIpv4(address), {
    onNone: () => isNotGlobalIpv6(address),
    onSome: (embedded) => notGlobal.check(embedded, "ipv4"),
  });
}

function bare(hostname: string): string {
  return pipe(Str.toLowerCase(hostname), Str.replaceAll(BRACKETS, ""), Str.replace(TRAILING_DOTS, ""));
}

function isPrivateHost(hostname: string): boolean {
  const host = bare(hostname);
  if (isIP(host) !== NOT_AN_ADDRESS) {
    return isPrivateAddress(host);
  }
  return host === LOCALHOST || Str.endsWith(UNDER_LOCALHOST)(host);
}

const refusals = new WeakSet<object>();

function refusal(hostname: string): Error {
  const refused = new Error(
    `${hostname} resolves to an address that isn't global unicast (loopback, private, link-local, reserved or the like), which a sign-in provider can't be on.`,
  );
  refusals.add(refused);
  return refused;
}

function systemResolve(hostname: string, resolved: Resolved): void {
  lookup(hostname, { all: true }, resolved);
}

interface Lookup {
  readonly hostname: string;
  readonly failure: Readonly<Error> | null;
  readonly addresses: readonly Readonly<LookupAddress>[] | undefined;
}

interface Looked {
  readonly failure: Readonly<Error> | null;
  readonly addresses: readonly Readonly<LookupAddress>[];
}

const NOTHING: readonly Readonly<LookupAddress>[] = [];

function isPrivateLookup(found: Readonly<LookupAddress>): boolean {
  return isPrivateAddress(found.address);
}

function checked({ addresses = NOTHING, failure, hostname }: Lookup): Looked {
  if (Predicate.isNotNull(failure)) {
    return { addresses: NOTHING, failure };
  }
  const unsafe = !Arr.isReadonlyArrayNonEmpty(addresses) || Arr.some(addresses, isPrivateLookup);
  const outcome = Option.liftPredicate(refusal(hostname), () => unsafe);
  const kept = Option.match(outcome, { onNone: Function.constant(addresses), onSome: Function.constant(NOTHING) });
  return { addresses: kept, failure: Option.getOrNull(outcome) };
}

function guardedLookupWith(resolve: Resolve): LookupFunction {
  return (hostname, _options: Readonly<LookupOptions>, answer) => {
    resolve(hostname, (failure, addresses) => {
      const looked = checked({ addresses, failure, hostname });
      answer(looked.failure, [...looked.addresses]);
    });
  };
}

function causesOf(failure: object): readonly unknown[] {
  return [Reflect.get(failure, "cause"), Reflect.get(failure, "reason")];
}

function refusedWithin(failure: unknown, depth: number): boolean {
  if (!Predicate.isObject(failure) || depth === NO_CAUSES) {
    return false;
  }
  return refusals.has(failure) || Arr.some(causesOf(failure), (cause) => refusedWithin(cause, depth - ONE_CAUSE));
}

function isGuardRefusal(failure: unknown): boolean {
  return refusedWithin(failure, MAX_CAUSES);
}

const guardedDispatcher = new Dispatcher1Wrapper(
  new Agent({ connect: { autoSelectFamily: true, lookup: guardedLookupWith(systemResolve) } }),
);

const guardedInit: GuardedInit = { dispatcher: guardedDispatcher, redirect: "manual" };

const plainInit: RequestInit = { redirect: "manual" };

function providerRequestInitOf(loopbackIssuer: boolean): RequestInit {
  if (loopbackIssuer) {
    return plainInit;
  }
  return guardedInit;
}

export { isGuardRefusal, isPrivateHost, providerRequestInitOf };
