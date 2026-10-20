# Host LeanFlow Web

Use a Linux server and a dedicated account with Docker access. Follow [Install LeanFlow Web](LemexWeb.md#install-and-run), then keep the app listening on `127.0.0.1:8090` behind an HTTPS reverse proxy.

## Storage and capacity

Choose a persistent directory for accounts, projects, and caches. For a separate data volume, set `STUDIO_DATA_DIR` in `.env` before preparing libraries; the directory must be writable by the service account. Docker images and containers also need space in Docker's data directory.

Expanding an existing filesystem makes its extra space available automatically. Moving existing data to another volume requires a planned migration. Additional disk space does not increase CPU, memory, or worker limits; review [capacity settings](Configuration.md#worker-capacity) for the intended workload. Keep private backups of the data directory and configuration; see [upgrade guidance](Configuration.md#back-up-before-upgrading).

## Run as a service

The supplied systemd user service assumes the checkout is `~/leanflow-web`. Adjust its paths and Node.js 24+ location if needed. Stop the foreground server before starting the service.

From the app directory:

```sh
mkdir -p .data ~/.config/systemd/user
cp .env .data/server.env
chmod 600 .data/server.env
cp deploy/leanflow-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now leanflow-web.service
```

The service reads `.data/server.env`; edit that file for subsequent configuration changes. `STUDIO_DATA_DIR` inside it can point to your separate volume. Ask the server administrator to enable lingering for this account so the service starts at boot and continues after logout.

Check status and logs with:

```sh
systemctl --user status leanflow-web.service
journalctl --user -u leanflow-web.service
```

## Upgrade without breaking open tabs

Build the new client in a staging directory. Keep the previous fingerprinted assets available for tabs that are still open, copy the new assets, and replace `index.html` last. Do not run a build that clears the live asset directory. Restart the service only after active work finishes; then verify sign-in, the editor, and streaming at the shared address.

## Set up a shared HTTPS address

For an address such as `https://lean.example.org`, arrange:

1. **DNS:** a record or alias pointing to the server or its reverse proxy.
2. **Network access:** HTTPS traffic must reach that proxy from the intended users' network. A private server may require a VPN or an externally reachable proxy.
3. **TLS:** a certificate covering the hostname, with renewal handled by the administrator or proxy.

An existing Nginx, Caddy, or institutional proxy works. Proxy the whole site to `http://127.0.0.1:8090`, including WebSocket upgrades and unbuffered event streams. Allow long-running assistant connections. If the proxy runs on another machine, use a protected connection to the app rather than exposing port 8090 publicly.

For Nginx, adapt the supplied [configuration](../deploy/nginx.conf.example), replace its hostname and certificate paths, validate with `nginx -t`, and reload Nginx. It includes [WebSocket upgrade headers](https://nginx.org/en/docs/http/websocket.html), unbuffered requests/responses, and a 208 MiB JSON envelope limit so the proxy does not reject valid uploads before the app applies its smaller decoded-source limits. Nginx's default 1 MiB body limit is too small for project imports. Keep certificate renewal configured with your administrator.

For a standalone proxy, use the supplied [Caddy configuration](../deploy/Caddyfile.example) and [Docker service instructions](Configuration.md#use-an-https-address). Caddy can obtain and renew public certificates automatically when its [DNS and network requirements](https://caddyserver.com/docs/automatic-https) are met, or use a certificate supplied by your institution.

Set the exact address in the app's service environment file:

```dotenv
STUDIO_ORIGIN=https://lean.example.org
```

When replacing a temporary tunnel, disable its service and any timer or script that rewrites `STUDIO_ORIGIN`. Update saved invitation links to the permanent address; account tokens do not need to change. Confirm the setting still points to the permanent address after restarting.

After active chats, checks, and setup have finished, restart the app:

```sh
systemctl --user restart leanflow-web.service
```

Wait for DNS to resolve from the users' network, then complete [verification before sharing](Verification.md). A certificate does not make a private IP publicly reachable. Share each account's [sign-in token](Configuration.md#accounts-and-personal-api-keys) privately and tell collaborators if a VPN is required.

## Optional: private access over SSH

For individual access to a server you can reach over SSH, run this on your own computer and keep it running:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8090:127.0.0.1:8090 user@server.example.org
```

Open **http://localhost:8090** and sign in. Connect to the server's VPN first if required. If local port 8090 is occupied, change the first `8090` to `8091` and open `http://localhost:8091`.

Leave `STUDIO_ORIGIN` unset for this private setup. Once an HTTPS origin is configured, use that HTTPS address: sign-in and writes through a different origin are rejected.
