import { expect, test } from '@playwright/test'

test('clearly marks local-only mode and exports a valid backup', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    })
  })
  await page.goto('/')

  const shortcut = page.getByTestId('cloud-status-shortcut')
  await expect(shortcut).toContainText('Chỉ trên máy')
  await shortcut.click()

  const panel = page.getByTestId('cloud-backup-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Chưa kết nối Firebase')
  await expect(panel).toContainText('Dữ liệu hiện chỉ nằm trong trình duyệt này')
  await page.screenshot({
    path: 'test-results/cloud-settings-desktop.png',
    fullPage: true,
  })

  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Lưu bản sao' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(
    /^vun-tu-backup-\d{4}-\d{2}-\d{2}\.json$/,
  )

  const stream = await download.createReadStream()
  let text = ''
  for await (const chunk of stream) text += chunk.toString()
  const backup = JSON.parse(text) as {
    format: string
    version: number
    data: { decks: unknown[]; cards: unknown[] }
  }

  expect(backup.format).toBe('vun-tu-backup')
  expect(backup.version).toBe(1)
  expect(backup.data.decks).toEqual([])
  expect(backup.data.cards).toEqual([])

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/cloud-settings-mobile.png',
    fullPage: true,
  })
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  expect(hasOverflow).toBe(false)
})
