import { Array as Arr, Effect, Option, Path, Record as Rec, Redacted, String as Str } from "effect";
import type { AssetStore, S3Bucket, Storage, StorageSetting, StorageUnavailable } from "../../../storage/server.ts";
import type { Config, FileSystem, Layer } from "effect";
import {
  assetStoreKind,
  assetStoreRule,
  assetsDirectory,
  databaseUrl,
  oidcSettings,
  s3SettingNames,
  s3Settings,
} from "../../../config/server.ts";
import {
  diskAssetStore,
  s3AssetStore,
  shownDatabase,
  storageSetting,
  withoutDatabaseSecret,
} from "../../../storage/server.ts";
import { isProviderIssuer, isProviderUrl } from "../../../identities/server.ts";
import type { CommandFailed } from "./output.ts";
import type { OidcSettings } from "../../../identities/server.ts";
import { refused } from "./output.ts";

type ServeStorage = (setting: StorageSetting) => Layer.Layer<Storage, StorageUnavailable, FileSystem.FileSystem>;

interface ServedStorage {
  readonly database: string;
  readonly redact: (text: string) => string;
  readonly setting: StorageSetting;
}

type ChosenAssetStore = Layer.Layer<AssetStore, StorageUnavailable, FileSystem.FileSystem | Path.Path>;

const ONE = 1;

const invalidKind = { code: "asset_store_invalid", message: assetStoreRule };

const invalidEndpoint = {
  code: "s3_endpoint_invalid",
  message: `${s3SettingNames.endpoint} must be a URL, such as https://<account>.r2.cloudflarestorage.com.`,
};

function assetsBeside(database: string): Effect.Effect<string, Config.ConfigError, Path.Path> {
  return Effect.gen(function* assetsFolder() {
    const chosen = yield* assetsDirectory;
    const path = yield* Path.Path;
    if (chosen === "") {
      return path.join(path.dirname(database), "assets");
    }
    return chosen;
  });
}

function notSet(names: readonly string[]): string {
  if (names.length === ONE) {
    return "is not set";
  }
  return "are not set";
}

function missingSettings(names: readonly string[]): Effect.Effect<never, CommandFailed> {
  const missing = {
    code: "s3_settings_missing",
    message: `COOKOUT_ASSET_STORE is s3, but ${Arr.join(names, ", ")} ${notSet(names)}. Set each, or leave COOKOUT_ASSET_STORE unset to keep attachments on disk.`,
  };
  return refused(missing);
}

const s3Store: Effect.Effect<ChosenAssetStore, Config.ConfigError | CommandFailed> = Effect.gen(function* s3Bucket() {
  const settings = yield* s3Settings;
  const unset = Arr.filter(Rec.keys(s3SettingNames), (key) => Str.isEmpty(Redacted.value(settings[key])));
  if (Arr.isReadonlyArrayNonEmpty(unset)) {
    return yield* missingSettings(Arr.map(unset, (key) => s3SettingNames[key]));
  }
  const endpoint = Redacted.value(settings.endpoint);
  if (!URL.canParse(endpoint)) {
    return yield* refused(invalidEndpoint);
  }
  const bucket: S3Bucket = {
    accessKey: Redacted.value(settings.accessKeyId),
    bucket: Redacted.value(settings.bucket),
    endpoint,
    region: Redacted.value(settings.region),
    secret: settings.secretAccessKey,
  };
  return s3AssetStore(bucket);
});

function chosenAssetStore(
  database: string,
): Effect.Effect<ChosenAssetStore, Config.ConfigError | CommandFailed, Path.Path> {
  return Effect.gen(function* chooseAssetStore() {
    const kind = yield* assetStoreKind.pipe(Effect.catchTag("ConfigError", () => refused(invalidKind)));
    if (kind === "s3") {
      return yield* s3Store;
    }
    const folder = yield* assetsBeside(database);
    return diskAssetStore(folder);
  });
}

function servedStorage(path: string): Effect.Effect<ServedStorage, Config.ConfigError> {
  return Effect.map(databaseUrl, (url) => {
    const setting = storageSetting({ path, url });
    return { database: shownDatabase(setting), redact: withoutDatabaseSecret(setting), setting };
  });
}

interface RequiredSetting {
  readonly name: string;
  readonly value: string;
}

interface ReadOidcSettings {
  readonly client: string;
  readonly clientSecret: Redacted.Redacted;
  readonly emailDomain: string;
  readonly issuer: string;
  readonly label: string;
}

const ISSUER = "COOKOUT_OIDC_ISSUER";
const EMAIL_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

const invalidIssuer = {
  code: "oidc_issuer_invalid",
  message: `${ISSUER} must be an https URL off private networks, such as https://example.authkit.app (plain http only on localhost, 127.0.0.1 or [::1]).`,
};

const insecurePublicUrl = {
  code: "oidc_public_url_insecure",
  message:
    "COOKOUT_PUBLIC_URL must be https for single sign-on, so its cookies are Secure (plain http only on localhost, 127.0.0.1 or [::1]).",
};

const invalidEmailDomain = {
  code: "oidc_email_domain_invalid",
  message:
    "COOKOUT_OIDC_EMAIL_DOMAIN must be one email domain, such as example.com: only verified addresses at exactly it sign in.",
};

function missingOidcSettings(names: readonly string[]): Effect.Effect<never, CommandFailed> {
  const missing = {
    code: "oidc_settings_missing",
    message: `${ISSUER} is set, but ${Arr.join(names, ", ")} ${notSet(names)}. Set each, or leave ${ISSUER} unset to turn single sign-on off.`,
  };
  return refused(missing);
}

function unsetNames(required: readonly RequiredSetting[]): readonly string[] {
  return Arr.map(
    Arr.filter(required, ({ value }) => Str.isEmpty(value)),
    ({ name }) => name,
  );
}

interface OidcRule {
  readonly holds: (settings: OidcSettings) => boolean;
  readonly refusal: { readonly code: string; readonly message: string };
}

const OIDC_RULES: readonly OidcRule[] = [
  { holds: ({ issuer }) => isProviderIssuer(issuer), refusal: invalidIssuer },
  { holds: ({ publicUrl }) => isProviderUrl(publicUrl), refusal: insecurePublicUrl },
  { holds: ({ emailDomain }) => EMAIL_DOMAIN.test(emailDomain), refusal: invalidEmailDomain },
];

function checkedOidcSettings(
  settings: ReadOidcSettings,
  publicUrl: string,
): Effect.Effect<OidcSettings, CommandFailed> {
  const emailDomain = Str.toLowerCase(settings.emailDomain);
  const unset = unsetNames([
    { name: "COOKOUT_PUBLIC_URL", value: publicUrl },
    { name: "COOKOUT_OIDC_CLIENT_ID", value: settings.client },
    { name: "COOKOUT_OIDC_EMAIL_DOMAIN", value: emailDomain },
  ]);
  if (Arr.isReadonlyArrayNonEmpty(unset)) {
    return missingOidcSettings(unset);
  }
  const clientSecret = Option.liftPredicate(settings.clientSecret, (given) => Str.isNonEmpty(Redacted.value(given)));
  const checked = { ...settings, clientSecret, emailDomain, publicUrl };
  return Option.match(
    Arr.findFirst(OIDC_RULES, ({ holds }) => !holds(checked)),
    { onNone: () => Effect.succeed(checked), onSome: ({ refusal }) => refused(refusal) },
  );
}

function oidcSettingsOrRefuse(
  publicUrl: string,
): Effect.Effect<Option.Option<OidcSettings>, Config.ConfigError | CommandFailed> {
  return Effect.flatMap(oidcSettings, (settings) => {
    if (Str.isEmpty(settings.issuer)) {
      return Effect.succeedNone;
    }
    return Effect.asSome(checkedOidcSettings(settings, publicUrl));
  });
}

export { chosenAssetStore, oidcSettingsOrRefuse, servedStorage };
export type { ServeStorage, ServedStorage };
