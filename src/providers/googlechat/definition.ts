import type { ProviderDefinition } from "../../core/types.ts";

import { googleChatActions } from "./actions.ts";
import { googleChatOAuthScopes } from "./scopes.ts";

const service = "googlechat";

/**
 * Google Chat provider backed by the Chat API and a user-provided Google OAuth app.
 *
 * Scoped to read-only space and message history access, which the Chat API
 * supports under user authentication.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Google Chat",
  description: "Read Google Chat spaces and message history as the authenticated Google Workspace user.",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: googleChatOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
      authorizationParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  ],
  homepageUrl: "https://workspace.google.com/products/chat/",
  actions: googleChatActions,
};
