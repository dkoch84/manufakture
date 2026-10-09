# Security reviews

One threat model per milestone that exposes something new. Each lists the assets, actors and entry points, every mitigation with its code and test, the residual risks, and a checklist for the maintainer's sign-off.

- [M7 threat model](m7-threat-model.md): the sync server, the app as its client, versions and branches, share links, scripts, the viewer and file imports, the service worker, static hosting, CI and deploy.
- [M8 threat model](m8-threat-model.md): agent sessions, the MCP server, the review bundle and the Review view, and scoped agent tokens on the sync server. Sign-off pending; agent tokens are for localhost only until it is signed.
