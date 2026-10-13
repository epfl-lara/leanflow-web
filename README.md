<p align="center"><img src="client/public/leanflow-mark.svg" width="80" height="80" alt="LeanFlow Web logo"></p>

# LeanFlow Web

Write, explore, and improve Lean proofs in your browser with a Lemex assistant.

Developed by [EPFL LARA](https://lara.epfl.ch/).

- **Bring your project:** import a Git repository or upload local files, with prepared Mathlib, CSLib, and Physlib environments.
- **Work with Lean:** edit code alongside live goals, diagnostics, and declaration search.
- **Work with Lemex:** choose a proof or select lines to prove, fix, or optimize. Follow its progress, send updates, and stop it whenever you need.
- **Stay in control:** review live edits, keep separate chats, and commit or push your changes.

## Get started

LeanFlow Web is self-hosted for you and trusted collaborators. You'll need Linux, Node.js 24+, Python 3.11+, Git, Docker, and a native Lemex installation.

```bash
git clone https://github.com/epfl-lara/lemex-web.git
cd lemex-web
```

Follow the **[installation guide](doc/LemexWeb.md#install-and-run)** to prepare Lemex, build the worker, configure your provider, and start the app. It also covers sign-in and access from another computer.

## Contribute

After setup, use `npm run dev` for development. Run `npm test`, `npm run check`, `npm run lint`, and `npm run build` before submitting changes.

See the [configuration guide](doc/LemexWeb.md) for hosting and [verification notes](doc/Verification.md) for runtime checks.

## Credits

Built on [lean4web](https://github.com/leanprover-community/lean4web), [lean4monaco](https://github.com/hhu-adam/lean4monaco), and the Lean infoview, with [Lemex](https://github.com/Lemmy00/lemex) and [LeanProbe](https://github.com/epfl-lara/LeanProbe).

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
