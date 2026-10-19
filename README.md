<p align="center"><img src="client/public/leanflow-mark.svg" width="80" height="80" alt="LeanFlow Web logo"></p>

# LeanFlow Web

Write, explore, and improve Lean proofs in your browser with a Lemex assistant.

Developed by [EPFL LARA](https://epfl-lara.github.io/).

- **Start with Lean:** use Mathlib Playground, import a Git repository, or upload your files.
- **Explore proofs:** edit alongside live goals, diagnostics, declaration search, and local Lean books.
- **Ask Lemex:** select a proof to complete, repair, or optimize, using models available with your own API key.
- **Write LaTeX:** edit documents beside their PDF with the optional TeX worker.
- **Stay in control:** review edits, steer separate chats, and commit or push your work.

## Get started

Self-host LeanFlow Web for yourself or trusted collaborators on Linux with Node.js 24+, Python 3.11+, Git, and Docker. Setup uses a precompiled Lemex release; no Rust build is needed.

- **[Install](doc/LemexWeb.md#install-and-run):** prepare the app and sign in.
- **[Host for a team](doc/Hosting.md):** add persistent storage, a service, and an HTTPS address.
- **[Use LeanFlow Web](doc/UsingLeanFlow.md):** work with projects, proofs, and Lemex.

## Contribute

After setup, use `npm run dev` for development with your settings exported. See [AGENTS.md](AGENTS.md) for code practices, formatting, and checks.

See [Configuration](doc/Configuration.md) for advanced settings, [Checks and releases](doc/Automation.md) for GitHub Actions, and [Verification](doc/Verification.md) for runtime checks.

## Credits

Built on [lean4web](https://github.com/leanprover-community/lean4web), [lean4monaco](https://github.com/hhu-adam/lean4monaco), and the Lean infoview, with [Lemex](https://github.com/Lemmy00/lemex) and [LeanProbe](https://github.com/epfl-lara/LeanProbe).

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
