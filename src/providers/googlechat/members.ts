import type { GoogleChatRuntimeContext } from "./runtime.ts";

import { compactObject, looseArray, optionalRecord, optionalString, recordOrEmpty } from "../../core/cast.ts";
import { ProviderRequestError } from "../provider-runtime.ts";
import { encodeResourceName, googleChatApiBaseUrl, googleChatJsonRequest, stripPrefix } from "./runtime.ts";

const peopleApiBaseUrl = "https://people.googleapis.com/v1";
// A direct message has at most two members, so this only guards against a
// pagination token that never runs out.
const maxDirectMessageMemberPages = 20;
/** people:batchGet accepts at most this many resource names per call. */
export const maxProfilesPerLookup = 200;
// google.rpc.Code values a per-person batchGet status can carry.
const rpcNotFound = 5;
const rpcPermissionDenied = 7;

interface ListMembershipsPayload {
  memberships?: unknown;
  nextPageToken?: string | null;
}

/**
 * A users/{id} user with the name and email Google Chat itself reported. Under
 * user authentication Chat only fills those in for members of the space and users
 * with prior affinity to the caller, so either may be missing.
 */
interface ChatUser {
  name: string;
  displayName: string | undefined;
  email: string | undefined;
}

interface ChatMember extends ChatUser {
  type: string | undefined;
  role: string | undefined;
}

interface ChatMemberPage {
  members: ChatMember[];
  nextPageToken: string | undefined;
}

type ProfileUnavailableReason =
  | "profile_name_missing"
  | "people_forbidden"
  | "people_not_found"
  | "people_request_failed";

interface MemberProfile {
  displayName: string | null;
  email: string | null;
  profileUnavailableReason?: ProfileUnavailableReason;
}

type DirectMessagePeerKind = "HUMAN" | "BOT" | "SELF" | "AMBIGUOUS";

interface DirectMessagePeer extends MemberProfile {
  kind: DirectMessagePeerKind;
  user: string | null;
  candidates?: string[];
}

interface SpaceMember extends MemberProfile {
  user: string;
  kind: string | undefined;
  role: string | undefined;
  isSelf: boolean;
}

interface SpaceMembersPage {
  members: SpaceMember[];
  nextPageToken: string | null;
}

interface SpaceMembersPageRequest {
  pageSize: number;
  pageToken: string | undefined;
}

/**
 * Name the other participant of a direct message. The authenticated user and the
 * peer are told apart by id, because a Chat membership never says which member is
 * "me". BOT and SELF are ordinary outcomes, not failures, and skip the directory.
 */
export async function resolveDirectMessagePeer(
  spaceName: string,
  context: GoogleChatRuntimeContext,
): Promise<DirectMessagePeer> {
  const [selfUser, members] = await Promise.all([readSelfUserName(context), listAllMembers(spaceName, context)]);
  const humans = members.filter((member) => member.type === "HUMAN");
  const bots = members.filter((member) => member.type === "BOT").map((member) => member.name);
  const others = humans.filter((member) => member.name !== selfUser);

  if (others.length === 1) {
    const [peer] = others;
    const profiles = await lookupProfiles(missingChatProfiles(others), context);
    return { kind: "HUMAN", user: peer.name, ...mergeProfile(peer, profiles.get(peer.name)) };
  }
  if (others.length > 1) {
    return unresolvedPeer(
      "AMBIGUOUS",
      null,
      others.map((member) => member.name),
    );
  }
  if (bots.length === 1) {
    return unresolvedPeer("BOT", bots[0]);
  }
  if (bots.length === 0 && humans.some((member) => member.name === selfUser)) {
    return unresolvedPeer("SELF", selfUser);
  }

  return unresolvedPeer("AMBIGUOUS", null, bots);
}

/**
 * One page of a space's members. Every human Google Chat left without a name or
 * email is looked up in a single batched directory call; the page size is capped
 * so one call always covers the page.
 */
export async function listSpaceMembersPage(
  spaceName: string,
  request: SpaceMembersPageRequest,
  context: GoogleChatRuntimeContext,
): Promise<SpaceMembersPage> {
  const [selfUser, page] = await Promise.all([readSelfUserName(context), fetchMemberPage(spaceName, request, context)]);
  const humans = page.members.filter((member) => member.type === "HUMAN");
  const profiles = await lookupProfiles(missingChatProfiles(humans), context);

  return {
    members: page.members.map((member) => ({
      user: member.name,
      kind: member.type,
      role: member.role,
      isSelf: member.name === selfUser,
      ...mergeProfile(member, profiles.get(member.name)),
    })),
    nextPageToken: page.nextPageToken ?? null,
  };
}

function unresolvedPeer(kind: DirectMessagePeerKind, user: string | null, candidates?: string[]): DirectMessagePeer {
  return { kind, user, displayName: null, email: null, candidates };
}

/** The authenticated user's own `users/{id}`; People and Chat share the id. */
async function readSelfUserName(context: GoogleChatRuntimeContext): Promise<string> {
  let payload: Record<string, unknown>;
  try {
    payload = recordOrEmpty(
      await googleChatJsonRequest<unknown>(`${peopleApiBaseUrl}/people/me`, {
        context,
        query: { personFields: "metadata" },
      }),
    );
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) {
      throw error;
    }
    throw new ProviderRequestError(
      error.status,
      `could not read the authenticated user's own id from the People API, so members cannot be told apart from the caller: ${error.message}. The People API must be enabled for the OAuth client's Google Cloud project.`,
      error.details,
    );
  }

  const resourceName = optionalString(payload.resourceName);
  if (!resourceName?.startsWith("people/")) {
    throw new ProviderRequestError(502, "the People API returned no resource name for the authenticated user");
  }

  return `users/${stripPrefix(resourceName, "people/")}`;
}

async function listAllMembers(spaceName: string, context: GoogleChatRuntimeContext): Promise<ChatMember[]> {
  let members: ChatMember[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxDirectMessageMemberPages; page += 1) {
    const result = await fetchMemberPage(spaceName, { pageSize: 100, pageToken }, context);
    members = [...members, ...result.members];
    pageToken = result.nextPageToken;
    if (!pageToken) {
      return members;
    }
  }

  throw new ProviderRequestError(502, `Google Chat kept paginating the members of ${spaceName}`);
}

async function fetchMemberPage(
  spaceName: string,
  request: SpaceMembersPageRequest,
  context: GoogleChatRuntimeContext,
): Promise<ChatMemberPage> {
  const payload = await googleChatJsonRequest<ListMembershipsPayload>(
    `${googleChatApiBaseUrl}/${encodeResourceName(spaceName)}/members`,
    {
      context,
      query: compactObject({
        pageSize: String(request.pageSize),
        pageToken: request.pageToken,
      }),
    },
  );

  return {
    members: looseArray(payload.memberships).flatMap((item) => toChatMember(item)),
    nextPageToken: optionalString(payload.nextPageToken),
  };
}

function toChatMember(value: unknown): ChatMember[] {
  const membership = recordOrEmpty(value);
  const member = recordOrEmpty(membership.member);
  const name = optionalString(member.name);
  return name
    ? [
        {
          name,
          type: optionalString(member.type),
          role: optionalString(membership.role),
          displayName: optionalString(member.displayName),
          email: optionalString(member.email),
        },
      ]
    : [];
}

/**
 * Fill in each human sender's name and email on normalized messages. Under user
 * authentication Chat reports them itself only for members of the space and users
 * with prior affinity to the caller, so every human sender missing either is
 * looked up in the directory. Distinct senders are looked up together, so a page
 * costs one extra request per 200 senders. A failed lookup leaves the message
 * intact with a null name and a reason; bots and messages without a sender are
 * left as they are.
 */
export async function attachSenderProfiles(
  messages: Record<string, unknown>[],
  context: GoogleChatRuntimeContext,
): Promise<Record<string, unknown>[]> {
  const profiles = await lookupProfiles(
    missingChatProfiles(messages.flatMap((message) => humanSender(message))),
    context,
  );

  return messages.map((message) => {
    const [sender] = humanSender(message);
    return sender
      ? { ...message, sender: { ...recordOrEmpty(message.sender), ...mergeProfile(sender, profiles.get(sender.name)) } }
      : message;
  });
}

/** The human users/{id} sender of a normalized message, if it has one. */
function humanSender(message: Record<string, unknown>): ChatUser[] {
  const sender = optionalRecord(message.sender);
  const name = optionalString(sender?.name);
  return sender?.type === "HUMAN" && name?.startsWith("users/")
    ? [{ name, displayName: optionalString(sender.displayName), email: optionalString(sender.email) }]
    : [];
}

/** The distinct users whose name or email Chat left out, which only the directory can fill in. */
function missingChatProfiles(users: ChatUser[]): string[] {
  const missing = users.filter((user) => user.displayName === undefined || user.email === undefined);
  return [...new Set(missing.map((user) => user.name))];
}

/**
 * Combine what Chat reported with the directory profile. Chat's own name and email
 * win and the directory only fills in what Chat left out, so a failed lookup never
 * replaces a known value with null. profileUnavailableReason explains a null
 * displayName, so it is only kept while the name is still missing.
 */
function mergeProfile(chat: ChatUser, directory: MemberProfile | undefined): MemberProfile {
  const displayName = chat.displayName ?? directory?.displayName ?? null;
  return {
    displayName,
    email: chat.email ?? directory?.email ?? null,
    profileUnavailableReason: displayName === null ? directory?.profileUnavailableReason : undefined,
  };
}

/**
 * Name `users/{id}` members through the Workspace directory, batching up to the
 * People API limit per call. A member whose profile cannot be read keeps a null
 * name and a reason; a failure of a whole call gives each member in it that reason.
 */
async function lookupProfiles(users: string[], context: GoogleChatRuntimeContext): Promise<Map<string, MemberProfile>> {
  const batches = Array.from({ length: Math.ceil(users.length / maxProfilesPerLookup) }, (_, index) =>
    users.slice(index * maxProfilesPerLookup, (index + 1) * maxProfilesPerLookup),
  );
  const results = await Promise.all(batches.map((batch) => lookupProfileBatch(batch, context)));
  return new Map(results.flatMap((result) => [...result]));
}

async function lookupProfileBatch(
  users: string[],
  context: GoogleChatRuntimeContext,
): Promise<Map<string, MemberProfile>> {
  let payload: Record<string, unknown>;
  try {
    payload = recordOrEmpty(
      await googleChatJsonRequest<unknown>(`${peopleApiBaseUrl}/people:batchGet`, {
        context,
        query: {
          resourceNames: users.map((user) => `people/${stripPrefix(user, "users/")}`),
          personFields: "names,emailAddresses",
          sources: "READ_SOURCE_TYPE_PROFILE",
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) {
      throw error;
    }
    const reason = httpFailureReason(error.status);
    return new Map(users.map((user) => [user, unavailableProfile(reason)]));
  }

  const responses = new Map(
    looseArray(payload.responses).map((entry) => {
      const response = recordOrEmpty(entry);
      return [optionalString(response.requestedResourceName), response] as const;
    }),
  );
  return new Map(users.map((user) => [user, toMemberProfile(responses.get(`people/${stripPrefix(user, "users/")}`))]));
}

function toMemberProfile(response: Record<string, unknown> | undefined): MemberProfile {
  // A missing entry says nothing about the person: a genuine miss comes back as its
  // own NOT_FOUND status, so an absent or unmatched entry is a malformed response.
  if (!response) {
    return unavailableProfile("people_request_failed");
  }
  const rpcCode = optionalRecord(response.status)?.code;
  if (typeof rpcCode === "number" && rpcCode !== 0) {
    return unavailableProfile(rpcFailureReason(rpcCode));
  }

  const person = recordOrEmpty(response.person);
  const displayName = primaryProfileValue(person.names, "displayName");
  return {
    displayName: displayName ?? null,
    email: primaryProfileValue(person.emailAddresses, "value") ?? null,
    // A 200 without a name is what a Workspace with profile sharing turned off returns.
    profileUnavailableReason: displayName ? undefined : "profile_name_missing",
  };
}

function unavailableProfile(reason: ProfileUnavailableReason): MemberProfile {
  return { displayName: null, email: null, profileUnavailableReason: reason };
}

/** Only 403 and 404 say something about the profile; anything else is a failed request, not a hidden one. */
function httpFailureReason(status: number): ProfileUnavailableReason {
  if (status === 403) {
    return "people_forbidden";
  }
  if (status === 404) {
    return "people_not_found";
  }
  return "people_request_failed";
}

function rpcFailureReason(code: number): ProfileUnavailableReason {
  if (code === rpcPermissionDenied) {
    return "people_forbidden";
  }
  if (code === rpcNotFound) {
    return "people_not_found";
  }
  return "people_request_failed";
}

function primaryProfileValue(value: unknown, field: string): string | undefined {
  const entries = looseArray(value).map((entry) => recordOrEmpty(entry));
  const primary = entries.find((entry) => optionalRecord(entry.metadata)?.primary === true) ?? entries[0];
  return optionalString(primary?.[field]);
}
