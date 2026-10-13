#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = process.env.STUDIO_DATA_DIR || path.join(project, '.data')
const token = (await fs.readFile(path.join(data, 'auth/owner.token'), 'utf8')).trim()
console.log(`Open http://localhost:${process.env.PORT || 8090}\n\nOwner access token (paste into the sign-in screen):\n${token}\n\nFor a remote browser, forward the server first:\nssh -L 8090:127.0.0.1:8090 milikic@larapc2`)
