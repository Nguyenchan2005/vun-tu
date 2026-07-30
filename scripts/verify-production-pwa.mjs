import { chromium } from '@playwright/test'

const baseUrl =
  process.env.PWA_PREVIEW_URL || 'http://127.0.0.1:4173/'
const edgePath =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({
  executablePath: edgePath,
  headless: true,
})

try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const browserErrors = []
  page.on('pageerror', (error) =>
    browserErrors.push(`pageerror: ${error.message}`),
  )
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`)
    }
  })
  page.on('requestfailed', (request) =>
    browserErrors.push(
      `requestfailed: ${request.url()} (${request.failure()?.errorText})`,
    ),
  )
  await page.goto(baseUrl)
  await page.getByTestId('dashboard-screen').waitFor()

  const workerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('Service worker did not claim the page.')),
          10_000,
        )
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            window.clearTimeout(timeout)
            resolve()
          },
          { once: true },
        )
      })
    }
    return registration.active?.scriptURL || ''
  })

  if (
    !workerUrl.includes('sw.js?app=index-') ||
    !workerUrl.includes('&sw=')
  ) {
    throw new Error(`Unexpected versioned worker URL: ${workerUrl}`)
  }

  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys()
    const shellName = names.find((name) =>
      name.startsWith('vun-tu-app-shell-v4-'),
    )
    if (!shellName) return { names, shellName: '', urls: [] }
    const cache = await caches.open(shellName)
    const urls = (await cache.keys()).map((request) => request.url)
    return { names, shellName, urls }
  })

  if (!cacheState.urls.some((url) => /ImportScreen-.+\.js$/.test(url))) {
    throw new Error('Lazy ImportScreen chunk is missing from app-shell cache.')
  }
  if (!cacheState.urls.some((url) => /lib-.+\.js$/.test(url))) {
    throw new Error('Lazy DOCX parser chunk is missing from app-shell cache.')
  }

  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  try {
    await page.getByTestId('dashboard-screen').waitFor({
      timeout: 10_000,
    })
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      body: document.body.innerText,
      html: document.documentElement.outerHTML.slice(0, 2_000),
      cacheNames: await caches.keys(),
    }))
    process.stderr.write(
      `${JSON.stringify(
        {
          ...diagnostics,
          cachedUrls: cacheState.urls,
          browserErrors,
        },
        null,
        2,
      )}\n`,
    )
    throw error
  }
  await page.getByTestId('header-import').click()
  await page.getByTestId('import-screen').waitFor()

  process.stdout.write(
    `${JSON.stringify(
      {
        workerUrl,
        shellCache: cacheState.shellName,
        cachedEntries: cacheState.urls.length,
        offlineDashboard: true,
        offlineLazyImport: true,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await browser.close()
}
