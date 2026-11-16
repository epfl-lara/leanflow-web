// PM2 runs the authenticated LeanFlow studio behind an HTTPS reverse proxy.
module.exports = {
  apps: [
    {
      name: 'lean4web',
      script: 'server/studio.mjs',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 8001,
      },
    },
  ],
}
