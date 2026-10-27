<p align="center"><img src="client/public/leanflow-mark.svg" width="80" height="80" alt="LeanFlow Web logo"></p>

# LeanFlow Web

Write, explore, and improve Lean proofs in your browser with a Lemex assistant.

Developed by [EPFL LARA](https://epfl-lara.github.io/).

- **Start with Lean:** use Mathlib Playground, import a Git repository, or upload your files.
- **Explore proofs:** edit alongside live goals, diagnostics, declaration search, and local Lean books.
- **Ask Lemex:** select a proof to complete, repair, or optimize, using models available with your own API key.
- **Write LaTeX:** edit documents beside their PDF with the optional TeX worker.
- **Stay in control:** review edits, steer separate chats, and commit or push your work.

If your imported repository has no Lean setup, choose a Lean version and libraries after import. LeanFlow adds the selected environment while keeping your existing files. Repositories with Lean configuration keep their pinned environment.

## Get started

**EPFL early access:** [Open LeanFlow](https://leanflow.epfl.ch/), available only from the **EPFL network or VPN**. Contact [lazar.milikic@epfl.ch](mailto:lazar.milikic@epfl.ch) for an early-access key.

Self-host LeanFlow Web for yourself or trusted collaborators on Linux with Node.js 24+, Python 3.11+, Git, and Docker. Setup uses a precompiled Lemex release; no Rust build is needed.

- **[Install](doc/LemexWeb.md#install-and-run):** prepare the app and sign in.
- **[Host for a team](doc/Hosting.md):** add persistent storage, a service, and an HTTPS address.
- **[Use LeanFlow Web](doc/UsingLeanFlow.md):** work with projects, proofs, and Lemex.

Each collaborator signs in with an individual access token and saves their own provider API key; EPFL RCP is the default. Before inviting a team, complete the short [installation verification](doc/Verification.md).

## Contributions and issues

- **Bugs and ideas:** search [existing issues](https://github.com/epfl-lara/leanflow-web/issues) before [opening an issue](https://github.com/epfl-lara/leanflow-web/issues/new). For bugs, include steps to reproduce, expected and actual behavior, and your browser and Lean version when relevant.
- **Contribute:** fork the repository, create a branch, and submit a focused pull request explaining the change and how you checked it. Discuss larger changes in an issue first.
- **Security:** report vulnerabilities privately using the [security policy](SECURITY.md). Keep access tokens, API keys, and private project content out of issues and pull requests.

After setup, use `npm run dev` for development with your settings exported. See [AGENTS.md](AGENTS.md) for code practices, formatting, and checks.

See [Configuration](doc/Configuration.md) for advanced settings and [Checks and releases](doc/Automation.md) for GitHub Actions.

## Credits

Built on [lean4web](https://github.com/leanprover-community/lean4web), [lean4monaco](https://github.com/hhu-adam/lean4monaco), and the Lean infoview, with [Lemex](https://github.com/Lemmy00/lemex) and [LeanProbe](https://github.com/epfl-lara/LeanProbe).

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
