import { expect, test } from '@playwright/test'

interface WebManifest {
  name: string
  short_name: string
  lang: string
  start_url: string
  scope: string
  display: string
  icons: Array<{
    src: string
    sizes: string
    type: string
    purpose: string
  }>
}

test('publishes Vietnamese install metadata, icons and offline shell', async ({
  page,
  request,
}) => {
  await page.goto('/')

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href')
  expect(manifestHref).toBe('/manifest.webmanifest')

  const manifestResponse = await request.get(manifestHref!)
  expect(manifestResponse.ok()).toBe(true)

  const manifest = (await manifestResponse.json()) as WebManifest
  expect(manifest.name).toContain('Vun Từ')
  expect(manifest.short_name).toBe('Vun Từ')
  expect(manifest.lang).toBe('vi')
  expect(manifest.start_url).toBe('./')
  expect(manifest.scope).toBe('./')
  expect(manifest.display).toBe('standalone')
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      }),
      expect.objectContaining({
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      }),
    ]),
  )

  for (const icon of manifest.icons) {
    const iconUrl = new URL(icon.src, manifestResponse.url())
    const iconResponse = await request.get(iconUrl.toString())
    expect(iconResponse.ok(), `${icon.sizes} icon should exist`).toBe(true)
    expect(iconResponse.headers()['content-type']).toContain('image/png')
  }

  const [serviceWorkerResponse, offlineResponse] = await Promise.all([
    request.get('/sw.js'),
    request.get('/offline.html'),
  ])
  expect(serviceWorkerResponse.ok()).toBe(true)
  expect(await serviceWorkerResponse.text()).toContain("CACHE_PREFIX = 'vun-tu'")
  expect(offlineResponse.ok()).toBe(true)
  expect(await offlineResponse.text()).toContain('Bạn đang ngoại tuyến')
})

test('service worker restores the app shell while offline', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('dashboard-screen')).toBeVisible()

  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
    await navigator.serviceWorker.ready

    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => resolve(),
          { once: true },
        )
      })
    }
  })

  // Reload once under service-worker control so imported development modules
  // are observed and cached by the same strategy used for production assets.
  await page.reload()
  await expect(page.getByTestId('dashboard-screen')).toBeVisible()

  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('dashboard-screen')).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})
