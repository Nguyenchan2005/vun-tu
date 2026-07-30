import { expect, test } from '@playwright/test'

test.skip(
  process.env.EXPECT_CLOUD_LOGIN !== '1',
  'Runs only with a disposable/dummy Firebase Web config.',
)

test('cloud build is login-only and remains responsive', async ({
  page,
  context,
}) => {
  await page.goto('/')
  const login = page.getByTestId('cloud-login-screen')
  await expect(login).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Đăng nhập để mở sổ học' }),
  ).toBeVisible()
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Mật khẩu')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Mở sổ học của tôi' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /đăng ký/i })).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/cloud-login-desktop.png',
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: 'test-results/cloud-login-mobile.png',
    fullPage: true,
  })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false)

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.getByText('Cần có mạng cho lần đăng nhập này.')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Mở sổ học của tôi' }),
  ).toBeDisabled()
})
