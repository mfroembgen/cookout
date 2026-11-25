import { Effect, Ref } from "effect";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

type Signer = "published" | "unpublished" | "rotated" | "rekeyed";

interface FakeKeys {
  readonly jwks: Effect.Effect<{ readonly keys: readonly unknown[] }>;
  readonly signed: (claims: Readonly<Record<string, unknown>>, signer: Signer) => Effect.Effect<string>;
}

interface SigningKey {
  readonly pair: "first" | "spare";
  readonly kid: string;
}

const KEY_ID = "fake-key-1";
const ROTATED_KEY_ID = "fake-key-2";
const ALGORITHM = "RS256";
const SEQUENTIALLY = { concurrency: 1 } as const;
const REKEYED: SigningKey = { kid: KEY_ID, pair: "spare" };
const ROTATED: SigningKey = { kid: ROTATED_KEY_ID, pair: "spare" };

const fakeKeys: Effect.Effect<FakeKeys> = Effect.gen(function* makeFakeKeys() {
  const pairs = {
    first: yield* Effect.promise(() => generateKeyPair(ALGORITHM)),
    spare: yield* Effect.promise(() => generateKeyPair(ALGORITHM)),
  };
  const [firstJwk, spareJwk] = yield* Effect.promise(() =>
    Promise.all([exportJWK(pairs.first.publicKey), exportJWK(pairs.spare.publicKey)]),
  );
  const published = yield* Ref.make<readonly unknown[]>([{ ...firstJwk, alg: ALGORITHM, kid: KEY_ID, use: "sig" }]);
  const current = yield* Ref.make<SigningKey>({ kid: KEY_ID, pair: "first" });
  const changes: Readonly<Record<Signer, Effect.Effect<SigningKey>>> = {
    published: Ref.get(current),
    rekeyed: Effect.as(
      Effect.all(
        [Ref.set(published, [{ ...spareJwk, alg: ALGORITHM, kid: KEY_ID, use: "sig" }]), Ref.set(current, REKEYED)],
        SEQUENTIALLY,
      ),
      REKEYED,
    ),
    rotated: Effect.as(
      Effect.all(
        [
          Ref.update(published, (keys) => [...keys, { ...spareJwk, alg: ALGORITHM, kid: ROTATED_KEY_ID, use: "sig" }]),
          Ref.set(current, ROTATED),
        ],
        SEQUENTIALLY,
      ),
      ROTATED,
    ),
    unpublished: Effect.gen(function* unpublishedKey() {
      const { kid } = yield* Ref.get(current);
      return { kid, pair: "spare" as const };
    }),
  };
  return {
    jwks: Effect.map(Ref.get(published), (keys) => ({ keys })),
    signed: (claims, signer) =>
      Effect.gen(function* sign() {
        const { kid, pair } = yield* changes[signer];
        const token = new SignJWT({ ...claims }).setProtectedHeader({ alg: ALGORITHM, kid });
        return yield* Effect.promise(() => token.sign(pairs[pair].privateKey));
      }),
  };
});

export { type FakeKeys, type Signer, fakeKeys };
