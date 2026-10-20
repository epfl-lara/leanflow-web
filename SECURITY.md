# Security Policy

## Supported versions

Security fixes are applied to `main`. Keep the app, its Docker worker, and system packages current, and follow the [upgrade and backup instructions](doc/Configuration.md#back-up-before-upgrading). A running worker retains its installed Lemex version until rebuilt and restarted.

## Report a vulnerability privately

Use [GitHub's private vulnerability report](https://github.com/epfl-lara/leanflow-web/security/advisories/new) for authentication, account isolation, credential exposure, worker containment, or other security issues in LeanFlow Web. Include the affected commit or release, minimal reproduction, and expected impact. Remove access tokens, API keys, personal files, and private deployment logs.

Do not post exploitable details or credentials in a public issue. Ordinary bugs without sensitive details can use [Issues](https://github.com/epfl-lara/leanflow-web/issues). Report upstream-only issues to the affected project's maintainers; LeanFlow Web does not maintain every dependency it includes.

## Deployment boundary

LeanFlow Web is intended for self-hosting by trusted collaborators with individual accounts. Run it behind HTTPS, keep the app's listening port private, and set its exact `STUDIO_ORIGIN`. Provider keys are stored encrypted in the private data directory; protect that directory and its backups as credentials.

Project setup and Lean tools execute project-controlled code in restricted Docker workers. Keep Docker and the host kernel patched. Assistant requests can send selected project content to the account's chosen provider. Independent proof checks rebuild source and check their stated verification conditions; a successful build alone is not a claim of complete proof verification.

See [Hosting](doc/Hosting.md), [project checks](doc/ProjectChecks.md), and [verification before sharing](doc/Verification.md).
