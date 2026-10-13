#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = process.env.STUDIO_DATA_DIR || path.join(project, '.data')
const token = (await fs.readFile(path.join(data, 'auth/owner.token'), 'utf8')).trim()
const port = process.env.PORT || 8090
console.log(`LeanFlow Web: http://localhost:${port}\n\nOwner access token (paste into the sign-in screen):\n${token}\n\nFor a remote browser, replace user@your-server with your SSH destination:\nssh -L ${port}:127.0.0.1:${port} user@your-server`)
