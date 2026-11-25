import { answer, freshDatabasePath, runServe, startServe } from "../../../testing/server.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { request } from "../../../http/client.ts";
import { secretsLive } from "../../../secrets/server.ts";
import { signInPath } from "../../../oidc/index.ts";

const EXIT_FAILURE = 1;

const OIDC_SETTINGS = {
  COOKOUT_OIDC_CLIENT_ID: "client-for-the-test",
  COOKOUT_OIDC_CLIENT_SECRET: "client-secret-for-the-test",
  COOKOUT_OIDC_EMAIL_DOMAIN: "Example.com",
  COOKOUT_OIDC_ISSUER: "https://sign-in.example.com",
  COOKOUT_PUBLIC_URL: "https://board.example.com",
};

const REQUIRED_WITH_THE_ISSUER = ["COOKOUT_PUBLIC_URL", "COOKOUT_OIDC_CLIENT_ID", "COOKOUT_OIDC_EMAIL_DOMAIN"] as const;

it.effect.each(REQUIRED_WITH_THE_ISSUER)(
  "cookout serve with COOKOUT_OIDC_ISSUER refuses to start without %s, naming it",
  (name) =>
    Effect.gen(function* refusesMissingOidcSetting() {
      const database = yield* freshDatabasePath;
      const refused = yield* runServe({ database, env: { ...OIDC_SETTINGS, [name]: "" } });

      expect(refused).toMatchObject({ exitCode: EXIT_FAILURE, stdout: "" });
      expect(refused.stderrJson).toStrictEqual({
        error: {
          code: "oidc_settings_missing",
          message: `COOKOUT_OIDC_ISSUER is set, but ${name} is not set. Set each, or leave COOKOUT_OIDC_ISSUER unset to turn single sign-on off.`,
        },
      });
    }).pipe(Effect.provide([NodeServices.layer, secretsLive])),
);

it.effect("cookout serve with only COOKOUT_OIDC_ISSUER names every setting it still needs", () =>
  Effect.gen(function* refusesAllMissing() {
    const refused = yield* runServe({
      database: yield* freshDatabasePath,
      env: { COOKOUT_OIDC_ISSUER: OIDC_SETTINGS.COOKOUT_OIDC_ISSUER },
    });

    expect(refused.stderr).toContain(
      "COOKOUT_PUBLIC_URL, COOKOUT_OIDC_CLIENT_ID, COOKOUT_OIDC_EMAIL_DOMAIN are not set",
    );
  }).pipe(Effect.provide([NodeServices.layer, secretsLive])),
);

it.effect(
  "cookout serve refuses a COOKOUT_OIDC_ISSUER that isn't https off localhost, and an email domain that isn't one",
  () =>
    Effect.gen(function* refusesBadOidcSettings() {
      const issuer = yield* runServe({
        database: yield* freshDatabasePath,
        env: { ...OIDC_SETTINGS, COOKOUT_OIDC_ISSUER: "http://sign-in.example.com" },
      });
      const notUrl = yield* runServe({
        database: yield* freshDatabasePath,
        env: { ...OIDC_SETTINGS, COOKOUT_OIDC_ISSUER: "sign-in.example.com" },
      });
      const domain = yield* runServe({
        database: yield* freshDatabasePath,
        env: { ...OIDC_SETTINGS, COOKOUT_OIDC_EMAIL_DOMAIN: "@example.com" },
      });

      expect([issuer.exitCode, notUrl.exitCode, domain.exitCode]).toStrictEqual([
        EXIT_FAILURE,
        EXIT_FAILURE,
        EXIT_FAILURE,
      ]);
      expect([issuer.stderrJson, notUrl.stderrJson, domain.stderrJson]).toMatchObject([
        { error: { code: "oidc_issuer_invalid" } },
        { error: { code: "oidc_issuer_invalid" } },
        { error: { code: "oidc_email_domain_invalid" } },
      ]);
      expect(`${issuer.stderr}${domain.stderr}`).not.toContain(OIDC_SETTINGS.COOKOUT_OIDC_CLIENT_SECRET);
    }).pipe(Effect.provide([NodeServices.layer, secretsLive])),
);

const PRIVATE_ISSUERS = [
  "https://0.1.2.3",
  "https://10.1.2.3",
  "https://100.64.0.1",
  "https://127.0.0.2",
  "https://169.254.169.254",
  "https://172.16.0.1",
  "https://192.0.0.8",
  "https://192.0.2.1",
  "https://192.88.99.1",
  "https://192.168.1.1",
  "https://198.18.0.1",
  "https://198.51.100.1",
  "https://203.0.113.1",
  "https://224.0.0.1",
  "https://255.255.255.255",
  "https://[::]",
  "https://[fd12:3456::1]",
  "https://[fe80::1]",
  "https://[ff02::1]",
  "https://[2001::1]",
  "https://[2001:db8::1]",
  "https://[3fff::1]",
  "https://[2002:c000:201::1]",
  "https://[::ffff:127.0.0.1]",
  "https://[::ffff:a9fe:a9fe]",
  "https://[::10.0.0.1]",
  "https://[64:ff9b::93.184.216.34]",
  "https://localhost.",
  "https://auth.localhost./",
];

it.effect.each(PRIVATE_ISSUERS)("cookout serve refuses a COOKOUT_OIDC_ISSUER on a private host: %s", (issuer) =>
  Effect.gen(function* refusesPrivateIssuer() {
    const served = yield* runServe({
      database: yield* freshDatabasePath,
      env: { ...OIDC_SETTINGS, COOKOUT_OIDC_ISSUER: issuer },
    });

    expect(served).toMatchObject({ exitCode: EXIT_FAILURE, stderrJson: { error: { code: "oidc_issuer_invalid" } } });
  }).pipe(Effect.provide([NodeServices.layer, secretsLive])),
);

it.effect.each([
  "https://100.128.0.1",
  "https://[2606:4700::1111]",
  "https://[::ffff:5db8:d822]",
  "https://[2001:200::1]",
])("cookout serve takes a COOKOUT_OIDC_ISSUER on a public address: %s", (issuer) =>
  Effect.gen(function* takesPublicIssuer() {
    const env = { ...OIDC_SETTINGS, COOKOUT_OIDC_ISSUER: issuer };
    const served = yield* startServe({ database: yield* freshDatabasePath, env });
    const signIn = yield* answer(() => request({ baseUrl: served.url, method: "GET", path: signInPath }));

    expect(signIn.json).toMatchObject({ oidc: true });
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, secretsLive])),
);

it.effect("cookout serve with single sign-on refuses a plain http COOKOUT_PUBLIC_URL off localhost", () =>
  Effect.gen(function* refusesPlainBoard() {
    const refused = yield* runServe({
      database: yield* freshDatabasePath,
      env: { ...OIDC_SETTINGS, COOKOUT_PUBLIC_URL: "http://board.example.com" },
    });

    expect(refused).toMatchObject({
      exitCode: EXIT_FAILURE,
      stderrJson: { error: { code: "oidc_public_url_insecure" } },
    });
  }).pipe(Effect.provide([NodeServices.layer, secretsLive])),
);

it.effect.each([
  { env: {}, label: "single sign-on", setting: "unset" },
  { env: { COOKOUT_OIDC_LABEL: "  Google  " }, label: "Google", setting: "set" },
  { env: { COOKOUT_OIDC_LABEL: " " }, label: "single sign-on", setting: "blank" },
] as const)(
  "cookout serve with the OIDC settings starts with single sign-on on, its COOKOUT_OIDC_LABEL $setting",
  ({ env, label }) =>
    Effect.gen(function* startsWithOidc() {
      const served = yield* startServe({ database: yield* freshDatabasePath, env: { ...OIDC_SETTINGS, ...env } });
      const signIn = yield* answer(() => request({ baseUrl: served.url, method: "GET", path: signInPath }));

      expect(signIn.json).toStrictEqual({ label, oidc: true, start: "https://board.example.com/v1/oidc/start" });
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, secretsLive])),
);
