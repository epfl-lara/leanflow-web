# Working on LeanFlow Web

LeanFlow Web uses React/TypeScript in `client/`, Node ESM in `server/`, and
small scripts in `scripts/`. Use Node 24 or newer and install with `npm ci`.

## Code

- Keep functions and components focused on one responsibility. Extract shared
  behavior into existing helpers before adding another copy or abstraction.
- Keep UI, API transport, workspace operations, and agent execution separate.
  Put reusable server logic in modules rather than expanding route handlers.
- Keep client API types aligned with server responses. Validate request data
  at the server boundary; avoid `any` and unchecked type assertions.
- Preserve the project's pinned Lean environment and the user's chosen model
  and reasoning effort. Report unsupported settings instead of changing them.
- Use the existing cancellation, event streaming, and conflict checks. Agent
  activity must leave scrolling, editing, and sending follow-ups responsive.
- Give users actionable errors. Keep internal logs and configuration details
  out of the interface unless they help the user resolve a problem.

## Formatting and checks

Use Oxfmt and Oxlint, not a second JavaScript formatter. Format only files
changed by the task; avoid unrelated cleanup or a repository-wide reformat.

```sh
npm run fmt -- path/to/changed-file.ts
npm run fmt:check -- path/to/changed-file.ts
npm run check
npm run lint
```

Format tracked Python helpers with Black 25.1.0. `uvx` installs the pinned
tool separately from the application dependencies:

```sh
uvx --from black==25.1.0 black scripts/package-lemex.py
uvx --from black==25.1.0 black --check scripts/package-lemex.py
```

Run `npm test` for behavior changes and `npm run build` for client or build
changes. Use the relevant `scripts/check-*.mjs` browser check for interactive
flows. These scripts may need a test server; inspect their setup first.

Add regression tests for bugs and changes to authentication, containment,
streaming, proof verification, or file conflicts. Test observable behavior,
not a copy of the implementation. Simple wording and documentation edits need
link and command checks, not new tests. Report checks run and any failures.

## Documentation

- Write for a person trying to use the product. Lead with the action and use
  short sentences, concrete examples, and copyable commands.
- Keep the README brief and installation steps in one short guide. Put
  optional administration and implementation details in separate documents.
- Keep setup instructions portable. Avoid a developer's machine name, home
  directory, private service URL, or unpublished local prerequisites.
- Describe current behavior; do not present proposals or unchecked claims as
  working features. Update links when moving a section.

## Runtime and credentials

- Keep checks isolated in `.runtime/` or temporary directories. Use fixtures;
  do not edit user projects or call a paid provider just to test the interface.
- Never interrupt active proof runs to validate or deploy a change. Check for
  active work before a necessary service restart.
- Keep credentials, `.env`, `.data/`, `.runtime/`, user projects, and private
  logs out of commits. Never print tokens or copy host credentials to workers.
- Continue routine work already authorized by the user. Ask only when a
  necessary decision is missing or an action exceeds that authorization.
