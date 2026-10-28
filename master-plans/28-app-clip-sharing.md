# Master plan 28: App Clip based sharing

**DELIBERATELY DRAFT: parked, not scheduled, not an accepted design.** Kirill asked
to keep the App Clip work on a branch in both repositories and to record it here
so App Clip based sharing can be supported later. Nothing below is approved work.
Do not build from this plan until Kirill reopens it and turns it into a real one.

The idea: an owner shares one link to a bot. A person with an iPhone taps it,
the App Clip opens without an install, they enter a name, and they chat with
that bot in a shared group conversation.

## End-to-end flow

```text
https://<host>/bot/invite/<token>
  -> AASA on <host>
  -> native App Clip: name onboarding, polling chat
  -> front server -> invite gateway (HTTPS /v1)
  -> exported bot on the owner's daemon (exported-bot WebSocket)
```

1. The invite link is `https://<host>/bot/invite/<token>`, where the token is
   16–512 base64url characters, with no query, fragment, or port. Capacity, bot,
   and guest identifiers never appear in the link.
2. The host serves `/.well-known/apple-app-site-association` as JSON with no
   redirect. It lists `466DQWDR8C.com.slopus.happy.preview.Clip` under
   `appclips` and the Preview parent `466DQWDR8C.com.slopus.happy.preview` under
   `applinks` for `/bot/invite/*`. The invitation page carries the App Clip
   smart banner.
3. The native App Clip asks for a self-reported display name, redeems the
   invitation, stores the session in the keychain, and long-polls the chat.
4. The front server forwards only the guest routes to the invite gateway:
   `POST /v1/bot-invites/redeem`, `GET`/`POST /v1/bot-guest/sessions/<id>/messages`,
   and `POST .../report` and `.../block`. It never exposes the owner API or the
   daemon socket. The gateway owns member identities, credentials, the shared
   guest transcript, limits, revocation, and reports.
5. The gateway speaks the existing exported-bot protocol to a dedicated bot on
   the owner's daemon. Each invitation is one preapproved daemon guest and
   subtask. Member names reach the agent only inside a quoted, unverified JSON
   envelope; the frame name is the fixed label `App Clip group`.

## Branches

- `slopus/happy-agent`, branch `experiment/app-clip-guests`, head `05fca86d1`:
  the invite gateway and front server in `packages/happy-bot-invite-bridge/`,
  its isolated demo scripts, the exported-bot gym scenario, and the branch's own
  continuation plan.
- `slopus/happy`, branch `app-clip-chat-look`, head
  `7430590e28ebd7a214f622ab1c6066d02785fb53`: the native App Clip and Preview
  changes, with `packages/happy-ios/docs/APP-CLIP.md` and the UltraView patch at
  `packages/happy-ios/AppClip/patches/ultraview-NodeTransitionAnimator-201.patch`.

Neither branch is merged to `main`.

## Verified so far

- The 18 invite gateway tests pass.
- An isolated demo on a quick tunnel,
  `replication-combat-drink-britain.trycloudflare.com`, served the AASA and
  produced a real bot reply through redeem, send, and long poll. It used a
  throwaway daemon, not the owner's.
- TestFlight Preview `2026.10.1` build 26 (plain guest screen, from local
  `f6b3f8b9`) and build 27 (main-app chat look, from `311f1c97`; the Clip is
  4.5 MB in a 47 MB app) were uploaded for internal testing only. Both were
  built with the local UltraView fix at `NodeTransitionAnimator.swift:201`.
  Kirill confirmed the Clip "kind of works" on a device.

## Needed for production

- A stable host or domain. The Preview host is compiled into
  `GuestInvitation.previewHost` and the associated-domain entitlements, so a
  quick tunnel dies with its process and every host change needs a new build.
- A real dedicated exported bot on the owner's daemon instead of the demo
  fixture.
- Real per-member guests sharing one daemon conversation, and guest names shown
  to the agent as quoted, unverified data. Both need an approved change to
  `packages/happy-agent/API.md` first; it is untouched.
- App Store Connect invocation URLs for the Clip. They are configured per build,
  so automating them needs an App Store Connect API key.
- A public App Clip experience, which requires an approved App Store version.
- Moderation and reporting good enough for App Review, including an operator
  workflow for the reports the gateway already records.
- The UltraView fix landed in `slopus/ultraview` and the pin bumped.
- Moving the guest session from the Clip to the full app through a shared
  keychain or App Group. Today, joining again from the full app takes a second
  seat.

## Open questions

- Who runs the gateway: each owner beside their own daemon, or a Happy-run
  multi-tenant broker that sees guest plaintext and holds export credentials?
- Which domain hosts invitations, and is it shared across owners or per owner?
- Should the group conversation stay one daemon guest per invitation, or become
  per-member guests once the API supports it?
- How do guests learn about replies when the Clip is closed? Push needs its own
  delivery and privacy design.
- What retention, quotas, and content policy apply to guest transcripts?
- Does Android need an equivalent instant-app path, or is iOS enough?
