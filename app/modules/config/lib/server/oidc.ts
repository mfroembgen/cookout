import { Config, Function, Option, Redacted, String as Str } from "effect";

const DEFAULT_LABEL = "single sign-on";

function setting(name: string): Config.Config<string> {
  return Config.String(name).pipe(Config.withDefault(""));
}

export const oidcSettings = Config.all({
  client: setting("COOKOUT_OIDC_CLIENT_ID"),
  clientSecret: Config.map(setting("COOKOUT_OIDC_CLIENT_SECRET"), (value) => Redacted.make(value)),
  emailDomain: setting("COOKOUT_OIDC_EMAIL_DOMAIN"),
  issuer: setting("COOKOUT_OIDC_ISSUER"),
  label: Config.map(setting("COOKOUT_OIDC_LABEL"), (value) =>
    Option.getOrElse(Option.liftPredicate(Str.trim(value), Str.isNonEmpty), Function.constant(DEFAULT_LABEL)),
  ),
});
