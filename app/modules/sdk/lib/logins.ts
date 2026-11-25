import {
  collectLoginRequestPath,
  loginPath,
  loginRequestApprovalPath,
  loginRequestPath,
  loginRequestsPath,
} from "../../logins/index.ts";
import { getJson, send } from "./request.ts";
import {
  isLoginCollectedResponse,
  isLoginRequestResponse,
  isLoginRequestStartedResponse,
  isLogoutResponse,
  isSignInResponse,
} from "./generated/validators.js";
import type { ClientConnection } from "./request.ts";
import type { LoginCalls } from "../../logins/index.ts";
import type { SignInCalls } from "../../oidc/index.ts";
import { signInPath } from "../../oidc/index.ts";

function signInCalls(server: ClientConnection): SignInCalls {
  return {
    signIn: async () => {
      const signIn = await getJson(server, signInPath, isSignInResponse);
      return signIn;
    },
  };
}

function loginCalls(server: ClientConnection): LoginCalls {
  return {
    approveLogin: async (userCode) => {
      const params = { code: userCode };
      const approved = await send(server, {
        isExpected: isLoginRequestResponse,
        method: "PUT",
        params,
        path: loginRequestApprovalPath,
      });
      return approved;
    },
    collectLogin: async (requestId) => {
      const body = { requestId };
      const collected = await send(server, {
        body,
        isExpected: isLoginCollectedResponse,
        method: "POST",
        path: collectLoginRequestPath,
      });
      return collected;
    },
    getLoginRequest: async (userCode) => {
      const params = { code: userCode };
      const found = await send(server, {
        isExpected: isLoginRequestResponse,
        method: "GET",
        params,
        path: loginRequestPath,
      });
      return found;
    },
    revokeLogin: async () => {
      const revoked = await send(server, { isExpected: isLogoutResponse, method: "DELETE", path: loginPath });
      return revoked;
    },
    startLogin: async (body) => {
      const started = await send(server, {
        body,
        isExpected: isLoginRequestStartedResponse,
        method: "POST",
        path: loginRequestsPath,
      });
      return started;
    },
  };
}

export { loginCalls, signInCalls };
export type { LoginCalls } from "../../logins/index.ts";
export type { SignInCalls } from "../../oidc/index.ts";
