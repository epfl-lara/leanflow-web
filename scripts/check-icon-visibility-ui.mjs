#!/usr/bin/env node
// Real controls with fixture-only APIs and sockets, including a deployed asset URL.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import * as Y from 'yjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/icon-visibility-ui')
await fs.mkdir(output, { recursive: true })
let server
let base = process.env.STUDIO_TEST_URL
if (!base) {
  const app = express()
  app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  base = `http://127.0.0.1:${server.address().port}`
}
const source = 'theorem identity (n : Nat) : n = n := by\n  rfl\n'
const doc = new Y.Doc()
doc.getText('source').insert(0, source)
const projectId = 'icon-project'
const checks = []
const measurements = []
let fixture
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'icon-owner', name: 'Icon fixture' },
      templates: [],
      models: [],
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Model and Calligraphy', status: 'ready' },
      { id: 'other-project', name: 'Another project', status: 'ready' },
    ],
    files: {
      [projectId]: { 'Main.lean': source, 'Other.lean': source },
      'other-project': { 'Main.lean': source },
    },
    chats: [{ id: 'icon-chat', projectId, title: 'A proof discussion' }],
    runs: [],
  })
  const { page } = fixture
  await page.routeWebSocket('**/websocket/collaboration/**', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw))
      if (request.type === 'open')
        socket.send(
          JSON.stringify({
            type: 'document',
            path: request.path,
            documentId: 'icon-document',
            update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
            content: source,
            hash: createHash('sha256').update(source).digest('hex'),
            openRequestId: request.requestId,
          }),
        )
    })
  })
  await fixture.ready()
  await page
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })

  const projectRow = page.locator('.project-row').filter({
    has: page.getByRole('button', {
      name: 'Actions for project Model and Calligraphy',
      exact: true,
    }),
  })
  const projectMenu = projectRow.locator('.row-menu-button')
  const menu = page.getByRole('menu')
  const measure = async (control, label, backdrop) => {
    const value = await control.evaluate((element, backdropSelector) => {
      const svg = element.querySelector('svg')
      const color = (text) => text.match(/[\d.]+/g).map(Number)
      const opaqueBackground = (node) => {
        while (node) {
          const result = color(getComputedStyle(node).backgroundColor)
          if ((result[3] ?? 1) >= 0.99) return result
          node = node.parentElement
        }
        return [255, 255, 255]
      }
      const own = color(getComputedStyle(element).backgroundColor)
      const behind = backdropSelector
        ? element
            .closest('.project-row, .file-row')
            .querySelector(backdropSelector)
        : element.parentElement
      const background = (own[3] ?? 1) >= 0.99 ? own : opaqueBackground(behind)
      const foreground = color(getComputedStyle(svg).color)
      const luminance = (rgb) =>
        rgb
          .slice(0, 3)
          .map((c) => {
            const value = c / 255
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4
          })
          .reduce(
            (sum, value, index) =>
              sum + value * [0.2126, 0.7152, 0.0722][index],
            0,
          )
      const levels = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      )
      let opacity = 1
      for (let node = element; node; node = node.parentElement)
        opacity *= Number(getComputedStyle(node).opacity)
      const bounds = element.getBoundingClientRect()
      return {
        contrast: (levels[0] + 0.05) / (levels[1] + 0.05),
        foreground,
        background,
        opacity,
        width: bounds.width,
        height: bounds.height,
        strokeWidth: parseFloat(getComputedStyle(svg).strokeWidth),
        dotDiameters: [...svg.querySelectorAll('circle')].map(
          (circle) =>
            (2 *
              Number(circle.getAttribute('r')) *
              svg.getBoundingClientRect().width) /
            24,
        ),
      }
    }, backdrop)
    assert(
      value.contrast >= 4.5,
      `${label}: enabled icon contrast ${value.contrast.toFixed(2)}`,
    )
    assert(value.opacity >= 0.99, `${label}: control is visible`)
    assert(value.strokeWidth >= 1.7, `${label}: icon strokes remain readable`)
    if (
      await control.evaluate((element) =>
        element.classList.contains('row-menu-button'),
      )
    ) {
      assert.equal(value.dotDiameters.length, 3, `${label}: three visible dots`)
      assert(
        value.dotDiameters.every((diameter) => diameter >= 2),
        `${label}: dots have visible area`,
      )
      assert.equal(value.width, 24)
      assert.equal(value.height, 28)
    }
    measurements.push({ label, ...value })
  }
  const inheritedColor = async (control) =>
    control.evaluate(
      (element) =>
        getComputedStyle(element).color ===
        getComputedStyle(element.querySelector('svg')).color,
    )

  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 1600, height: 1000 })
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: `Use ${theme} theme`, exact: true })
        .click()
    await page.getByRole('button', { name: 'New file', exact: true }).focus()
    await page.mouse.move(1200, 900)
    assert.equal(
      await projectMenu.evaluate(
        (element) => getComputedStyle(element).opacity,
      ),
      '0',
      'desktop rows remain quiet before interaction',
    )
    await page.getByRole('button', { name: 'New file', exact: true }).blur()

    for (const row of [
      projectRow,
      page.locator('.project-row').filter({
        has: page.getByRole('button', {
          name: 'Actions for project Another project',
          exact: true,
        }),
      }),
    ]) {
      await row.locator('.project-item').hover()
      await measure(
        row.locator('.row-menu-button'),
        `${theme} project ${await row.locator('.project-item').getAttribute('aria-current')} hover`,
        '.project-item',
      )
    }
    await projectRow.locator('.project-item').hover()
    await page
      .locator('.sidebar')
      .screenshot({ path: path.join(output, `${theme}-selected-project.png`) })
    await projectMenu.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    assert(
      await projectMenu.evaluate((element) =>
        element.matches(':focus-visible'),
      ),
    )
    await measure(projectMenu, `${theme} keyboard focus`, '.project-item')
    assert(
      await projectMenu.evaluate(
        (element) => getComputedStyle(element).outlineStyle !== 'none',
      ),
    )
    await page.keyboard.press('Enter')
    await menu.waitFor()
    await page.mouse.move(1200, 900)
    await measure(projectMenu, `${theme} menu open`, '.project-item')
    assert.equal(await projectMenu.getAttribute('aria-expanded'), 'true')
    await page.screenshot({
      path: path.join(output, `${theme}-keyboard-menu.png`),
    })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert(
      await projectMenu.evaluate(
        (element) => document.activeElement === element,
      ),
    )

    for (const filePath of ['Main.lean', 'Other.lean']) {
      const fileMenu = page.getByRole('button', {
        name: `Actions for file ${filePath}`,
        exact: true,
      })
      await fileMenu.locator('..').locator('.file-item').hover()
      await measure(fileMenu, `${theme} ${filePath} menu`, '.file-item')
      await fileMenu.click()
      await menu.waitFor()
      await page.keyboard.press('Escape')
    }
    for (const label of [
      'New file',
      'New folder',
      'Refresh files',
      'Open Trash',
      'Rename chat',
      'About Projects',
    ]) {
      const button = page.getByRole('button', { name: label, exact: true })
      await page.mouse.move(1200, 900)
      await measure(button, `${theme} ${label}`)
    }
    const selected = page
      .locator('.toolbar-action.selected > .button:has(svg)')
      .first()
    assert(
      await inheritedColor(selected),
      'selected toolbar icon follows its label color',
    )
    const trash = projectRow.locator('.project-delete')
    await projectRow.locator('.project-item').hover()
    await trash.hover()
    await measure(trash, `${theme} delete hover`)
    assert(
      await trash.evaluate((element) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--danger)'
        element.append(probe)
        const matches =
          getComputedStyle(probe).color ===
          getComputedStyle(element.querySelector('svg')).color
        probe.remove()
        return matches
      }),
      'destructive icons keep their danger color',
    )
    const save = page.getByRole('button', { name: 'Save', exact: true })
    assert(await save.isDisabled())
    assert(
      Number(
        await save.evaluate((element) => getComputedStyle(element).opacity),
      ) < 1,
      'disabled controls stay visually distinct',
    )
    checks.push(
      `${theme}: selected/unselected project and file menus, keyboard reveal/focus/escape, shared controls, danger and disabled states`,
    )
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  })
  const touch = async (element) => {
    const box = await element.boundingBox()
    assert(box)
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  }
  await touch(
    page.getByRole('button', { name: 'Open projects and files', exact: true }),
  )
  await until(
    () =>
      page
        .locator('.sidebar')
        .evaluate(
          (element) =>
            getComputedStyle(element).transform === 'matrix(1, 0, 0, 1, 0, 0)',
        ),
    'mobile sidebar',
  )
  assert(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))
  for (const theme of ['light', 'dark']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await touch(
        page.getByRole('button', { name: `Use ${theme} theme`, exact: true }),
      )
    await measure(
      projectMenu,
      `${theme} touch selected project`,
      '.project-item',
    )
    await touch(projectMenu)
    await menu.waitFor()
    await measure(projectMenu, `${theme} touch open menu`, '.project-item')
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    )
    await page.screenshot({
      path: path.join(output, `${theme}-touch-menu.png`),
    })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
  }
  await cdp.detach()
  checks.push(
    '390px touch: coarse-pointer menus are visible, tappable and contained in both themes',
  )
  fixture.assertClean()
  const minimumContrast = Math.min(
    ...measurements.map((value) => value.contrast),
  )
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      { passed: true, checks, minimumContrast, measurements },
      null,
      2,
    ) + '\n',
  )
  await fs.rm(path.join(output, 'failure.png'), { force: true })
  console.log(JSON.stringify({ passed: true, checks, minimumContrast }))
} catch (error) {
  await fixture?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fixture?.browser.close()
  doc.destroy()
  if (server) await new Promise((resolve) => server.close(resolve))
}
