import type { IsoTime } from "../../time/index.ts";

type WithSignIn<Shown> = Shown & {
  readonly signIn?: { readonly email: string; readonly linkedAt: IsoTime };
};

export type { WithSignIn };
