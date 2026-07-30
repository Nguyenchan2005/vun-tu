import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} from 'docx'
import writeExcelFile from 'write-excel-file/node'

const csvFixture = path.join(
  import.meta.dirname,
  'fixtures/sample-vocab.csv',
)

async function openFileStep(
  page: Page,
  folderName?: string,
): Promise<void> {
  await page.goto('/')
  await page.getByTestId('header-import').click()
  await expect(page.getByTestId('import-screen')).toBeVisible()

  if (folderName) {
    await page.getByTestId('folder-mode-custom').click()
    await page.getByTestId('folder-name-input').fill(folderName)
  }

  await page
    .getByRole('button', { name: 'Tiếp theo: chọn tệp' })
    .click()
  await expect(page.getByTestId('import-file-input')).toBeAttached()
}

async function importCsvAndSave(
  page: Page,
  folderName: string,
): Promise<void> {
  await openFileStep(page, folderName)
  await page.getByTestId('import-file-input').setInputFiles(csvFixture)
  await expect(
    page.getByRole('heading', { name: 'Hai mặt thẻ đã đúng chưa?' }),
  ).toBeVisible()
  await page.getByRole('button', { name: /Tiếp tục với 4 thẻ/ }).click()
  await page
    .getByRole('button', { name: new RegExp(`Lưu 4 thẻ vào “${folderName}”`) })
    .click()
  await expect(page.getByTestId('import-success')).toBeVisible()
}

function cell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph(text)],
  })
}

test('dashboard starts empty without contextual demo decks or console errors', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto('/')
  await expect(page.getByTestId('dashboard-screen')).toBeVisible()
  await expect(page.getByTestId('dashboard-empty')).toBeVisible()
  await expect(page.locator('.dashboard-deck-card')).toHaveCount(0)
  await page.screenshot({
    path: 'test-results/dashboard-desktop.png',
    fullPage: true,
  })

  expect(errors).toEqual([])
})

test('imports first, then flips, rates and advances a study card', async ({
  page,
}) => {
  await importCsvAndSave(page, 'Bộ học thử')
  await page.getByRole('button', { name: 'Học ngay' }).click()
  await expect(page.getByTestId('study-screen')).toBeVisible()
  await page.screenshot({
    path: 'test-results/study-front.png',
    fullPage: true,
  })

  const firstWord = await page.locator('.flashcard-front > strong').innerText()
  await page.getByTestId('flashcard').click()
  await expect(page.getByTestId('flashcard')).toHaveClass(/is-flipped/)
  await page.waitForTimeout(500)
  await page.screenshot({
    path: 'test-results/study-back.png',
    fullPage: true,
  })
  await page.locator('.rating-good').click()
  await expect(page.getByTestId('flashcard')).toBeVisible()
  await expect(page.locator('.flashcard-front > strong')).not.toHaveText(
    firstWord,
  )

  await page.locator('.study-exit').click()
  await expect(page.locator('.leave-dialog')).toBeVisible()
  await page.locator('.leave-dialog .button-ghost').click()
  await expect(page.getByTestId('dashboard-screen')).toBeVisible()
})

test('asks for a folder first and keeps the uploaded CSV filename', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('header-import').click()

  await expect(
    page.getByText('Không tự phân loại theo ngữ cảnh'),
  ).toBeVisible()
  await page.getByTestId('folder-mode-custom').click()
  await page.getByTestId('folder-name-input').fill('Từ mới thử nghiệm')
  await page
    .getByRole('button', { name: 'Tiếp theo: chọn tệp' })
    .click()
  await page.getByTestId('import-file-input').setInputFiles(csvFixture)

  await expect(
    page.getByRole('heading', { name: 'Hai mặt thẻ đã đúng chưa?' }),
  ).toBeVisible()
  await expect(page.locator('.preview-table tbody tr')).toHaveCount(4)
  await page.screenshot({
    path: 'test-results/import-mapping.png',
    fullPage: true,
  })

  await page.getByRole('button', { name: /Tiếp tục với 4 thẻ/ }).click()
  await expect(page.locator('.import-summary-v2')).toContainText(
    'sample-vocab.csv',
  )
  await page.screenshot({
    path: 'test-results/import-save.png',
    fullPage: true,
  })
  await page
    .getByRole('button', {
      name: 'Lưu 4 thẻ vào “Từ mới thử nghiệm”',
    })
    .click()

  await expect(page.getByTestId('import-success')).toContainText(
    'Từ mới thử nghiệm',
  )
  await expect(page.getByTestId('import-success')).toContainText(
    'sample-vocab.csv',
  )
  await page.getByRole('button', { name: 'Về trang chủ' }).click()
  await expect(page.getByTestId('dashboard-screen')).toContainText(
    'sample-vocab.csv',
  )
})

test('uses the import date when no custom folder name is provided', async ({
  page,
}) => {
  await openFileStep(page)
  await page.getByTestId('import-file-input').setInputFiles(csvFixture)
  await page.getByRole('button', { name: /Tiếp tục với 4 thẻ/ }).click()

  const datedFolder = `Từ vựng ${new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
    .format(new Date())
    .replaceAll('/', '-')}`
  await expect(page.locator('.import-summary-v2')).toContainText(datedFolder)
  await page
    .getByRole('button', {
      name: `Lưu 4 thẻ vào “${datedFolder}”`,
    })
    .click()
  await expect(page.getByTestId('import-success')).toContainText(datedFolder)
})

test('uploads a real XLSX workbook and detects reversed columns', async ({
  page,
}, testInfo) => {
  const workbookPath = testInfo.outputPath('sample-vocab.xlsx')
  await writeExcelFile([
    ['Nghĩa', 'English', 'Ghi chú'],
    ['bình tĩnh', 'calm', 'mẫu'],
    ['chính xác', 'accurate', 'mẫu'],
  ]).toFile(workbookPath)

  await openFileStep(page, 'Bảng tính')
  await page.getByTestId('import-file-input').setInputFiles(workbookPath)

  await expect(page.getByTestId('english-column').locator('select')).toHaveValue(
    '1',
  )
  await expect(page.locator('.preview-table tbody tr')).toHaveCount(2)
  await expect(page.locator('.preview-table tbody')).toContainText('accurate')
  await expect(page.locator('.preview-table tbody')).toContainText('chính xác')
})

test('reads a real two-column DOCX table', async ({ page }, testInfo) => {
  const documentPath = testInfo.outputPath('word-vocabulary.docx')
  const document = new Document({
    sections: [
      {
        children: [
          new Table({
            rows: [
              new TableRow({
                children: [cell('English'), cell('Nghĩa')],
              }),
              new TableRow({
                children: [cell('thoughtful'), cell('chu đáo')],
              }),
              new TableRow({
                children: [cell('resilient'), cell('kiên cường')],
              }),
            ],
          }),
        ],
      },
    ],
  })
  await writeFile(documentPath, await Packer.toBuffer(document))

  await openFileStep(page, 'Từ trong Word')
  await page.getByTestId('import-file-input').setInputFiles(documentPath)

  await expect(page.locator('.preview-table tbody tr')).toHaveCount(2)
  await expect(page.locator('.preview-table tbody')).toContainText('thoughtful')
  await expect(page.locator('.preview-table tbody')).toContainText('kiên cường')
})

test('reads a tab-separated TXT upload', async ({ page }) => {
  await openFileStep(page, 'Ghi chú TXT')
  await page.getByTestId('import-file-input').setInputFiles({
    name: 'daily-vocabulary.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'English\tVietnamese\ncurious\ttò mò\ngentle\tdịu dàng',
      'utf8',
    ),
  })

  await expect(page.locator('.preview-table tbody tr')).toHaveCount(2)
  await expect(page.locator('.preview-table tbody')).toContainText('curious')
  await expect(page.locator('.preview-table tbody')).toContainText('dịu dàng')
})

test('supports the redesigned system dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByTestId('dashboard-screen')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--paper')
          .trim(),
      ),
    )
    .toBe('#111a16')
  await page.screenshot({
    path: 'test-results/dashboard-dark.png',
    fullPage: true,
  })
})

test('reminder times can be added and mobile layout has no overflow', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByTestId('header-nav-reminders').click()
  await expect(page.getByTestId('settings-screen')).toBeVisible()
  await page.screenshot({
    path: 'test-results/settings-desktop.png',
    fullPage: true,
  })
  await page.locator('input[type="time"]').fill('06:45')
  await page.getByRole('button', { name: 'Thêm giờ' }).click()
  await expect(
    page.locator('.time-row').filter({ hasText: '06:45' }),
  ).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.getByTestId('mobile-nav')).toBeVisible()
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
  await page.screenshot({
    path: 'test-results/dashboard-mobile.png',
    fullPage: true,
  })
})
