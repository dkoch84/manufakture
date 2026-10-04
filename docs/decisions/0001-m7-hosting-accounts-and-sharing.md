# 0001: M7 hosting, accounts, sharing and data policy

- Status: accepted
- Date: 2026-10-04

## Context

M7 adds the first server ([0000: Product decisions](0000-product-decisions.md), decision 1), share links and scripts that arrive inside other people's documents. Task T7.0a of [the M7 plan](../plans/m7.md) lists the questions an agent must not answer on its own: whether a hosted service is run, where the app is served and under whose name, accounts, the database, share-link limits and policies, and whether scripts from other people's documents run on open. [ADR 0009](../adr/0009-sync-model.md) decision 12 and [ADR 0010](../adr/0010-scripting-sandbox.md) decision 9 waited on the same answers. The maintainer answered them on 2026-10-04; this record writes them down.

## Decisions

1. **Self-host first; no hosted service in M7.** The sync server is software a user runs on their own machine or network. The project operates no sync service. A hosted service is deferred, not ruled out: if one is run later, the questions it raises (accounts, Postgres, abuse handling, takedown, privacy) get a decision record of their own before it opens.

2. **One user per instance, no accounts.** A self-hosted instance serves one user and is protected by one bearer token, set by whoever runs it. There is no sign-up, no sign-in method and no per-document roles. Several editors with accounts (T7.1h) are skipped in M7; ADR 0009's rebase notices are used by one person across devices first.

3. **SQLite.** The server stores logs, snapshots, blobs and shares in SQLite (ADR 0009 decision 11). The Postgres store (T7.1g) is skipped in M7; it belongs with a hosted service if one is ever run.

4. **Static host: self-hosted.** The project's own deployment of the app and the viewer (T7.3c) is self-hosted on the maintainer's private Kubernetes cluster, served over HTTPS and reachable only on the private network. It is not a public deployment. The host can set response headers per path, so nothing in T7.3c is limited by the host; whether to send COOP and COEP stays as ADR 0002 and T7.3c decide. The generic headers file of T7.3c remains the starting point for anyone else who self-hosts.

5. **Domain, DNS and TLS: the maintainer's own.** The maintainer holds the domain, the DNS records and the TLS certificates of that deployment. The domain is a deployment variable (a CI secret or a value in the deployment's configuration), never written into the repository.

6. **Share links: limits and retention.** For T7.3d:
   - a share expires after **30 days** by default; the user can pick another expiry, or **never**;
   - per server token: at most **50 MB** per bundle and at most **100 active shares** (expired and revoked shares do not count).

7. **Takedown and privacy: the self-hoster's responsibility.** Share links are served only by self-hosted instances, so whoever runs an instance is responsible for what it serves. M7 publishes no takedown contact and no privacy notice; the server and sharing docs say this plainly. A hosted service (decision 1) would need both before it opens.

8. **Data policy.** Documents, logs, blobs and shares stay on the user's own devices and on the server the user runs. Nothing is sent to, stored by or operated by the project. The app keeps working with no server at all (M7 plan, "Decisions that cut across tasks", item 1).

9. **Scripts in other people's documents run on open, after the security sign-off.** Once the human security sign-off (T7.6b) has been recorded, scripts in a document from someone else run on open without asking, and the setting **Run scripts in documents automatically** (T7.2d) defaults to on; the user can turn it off, which brings back the per-document opt-in. Until then the per-document opt-in of T7.2d applies regardless of where the document came from. Without accounts there is no author to show, so the app shows which features are scripted, not who edited them. This answers ADR 0010 decision 9.

10. **Script API versions are a permanent promise.** The script API is versioned, and a script written against an API version runs unchanged, with the same results, for as long as the app exists: the same promise the file format makes ([ADR 0004](../adr/0004-document-format.md) decision 2). This answers the second half of ADR 0010 decision 9.

## Consequences

- T7.1g and T7.1h are skipped in M7. T7.6a's threat model does not cover them, and T7.5 does not wait for them (as the M7 plan already allows for skipped tasks).
- T7.1c builds single-user token authentication and the SQLite store only. Its docs describe running the server on localhost or a private network.
- T7.3c's live deploy targets the maintainer's private cluster. The deploy workflow reads the host and domain from configuration, so the repository names neither. Because that deployment is private, T7.6b's sign-off gates scripts running on open (decision 9) and any later public deployment, not this one.
- T7.3d implements the limits of decision 6, with tests for expiry, never-expiring shares, the size cap and the count cap. `docs/user/sharing.md` and `docs/hosting.md` state the self-hoster's responsibility (decision 7).
- ADR 0009 decision 12 and ADR 0010 decision 9 are answered by this record; both ADRs are accepted with the amendments their spikes called for.
- A hosted service, accounts, Postgres, a takedown contact and a privacy notice are deferred together, to one future decision record.
