import { describe, expect, it } from 'vitest'
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
} from 'docx'
import writeExcelFile from 'write-excel-file/universal'

import {
  VocabularyParseError,
  analyzeRows,
  extractHtmlTableRows,
  extractMarkdownTableRows,
  jsonToRows,
  normalizeGoogleSheetsUrl,
  parseDelimitedText,
  parseDocx,
  parseFile,
  parseFlexibleText,
  parseGoogleSheet,
  parseHtmlText,
  parseJsonText,
  parseMarkdownText,
  parseRtfText,
  remapColumns,
  rtfToPlainText,
} from './parser'

describe('vocabulary parser', () => {
  it('detects explicit headers and maps English/Vietnamese columns', () => {
    const parsed = analyzeRows([
      ['Loại từ', 'Nghĩa', 'English'],
      ['noun', 'quả táo', 'apple'],
      ['verb', 'chạy nhanh', 'run'],
    ])

    expect(parsed.hasHeader).toBe(true)
    expect(parsed.mapping).toMatchObject({
      englishColumn: 2,
      vietnameseColumn: 1,
    })
    expect(parsed.cards).toEqual([
      { front: 'apple', back: 'quả táo', sourceRow: 2 },
      { front: 'run', back: 'chạy nhanh', sourceRow: 3 },
    ])
  })

  it('infers columns from content when a file has no header', () => {
    const parsed = analyzeRows([
      ['apple', 'quả táo'],
      ['book', 'quyển sách'],
      ['remember', 'ghi nhớ'],
    ])

    expect(parsed.hasHeader).toBe(false)
    expect(parsed.headers).toEqual(['Cột 1', 'Cột 2'])
    expect(parsed.mapping).toMatchObject({
      englishColumn: 0,
      vietnameseColumn: 1,
    })
    expect(parsed.cards).toHaveLength(3)
    expect(parsed.cards[0]?.sourceRow).toBe(1)
  })

  it('auto-detects a tab delimiter and ignores empty rows', () => {
    const parsed = parseDelimitedText(
      'Word\tMeaning\nhello\txin chào\n\nworld\tthế giới\n',
    )

    expect(parsed.cards.map(({ front, back }) => [front, back])).toEqual([
      ['hello', 'xin chào'],
      ['world', 'thế giới'],
    ])
  })

  it.each([
    ['tab', '\t'],
    ['comma', ','],
    ['semicolon', ';'],
    ['pipe', '|'],
    ['colon', ':'],
    ['spaced dash', ' - '],
    ['bare dash', '-'],
    ['en dash', ' – '],
  ])('accepts %s-delimited plain text', (_label, delimiter) => {
    const parsed = parseFlexibleText(
      `English${delimiter}Meaning\napple${delimiter}quả táo\nbook${delimiter}quyển sách`,
    )

    expect(parsed.cards.map(({ front, back }) => [front, back])).toEqual([
      ['apple', 'quả táo'],
      ['book', 'quyển sách'],
    ])
  })

  it('extracts and parses a Markdown pipe table', () => {
    const markdown = [
      '# Bộ từ',
      '',
      '| English | Meaning | Note |',
      '| :--- | ---: | --- |',
      '| turn \\| off | tắt | phrasal verb |',
      '| patient | kiên nhẫn | adjective |',
    ].join('\n')

    expect(extractMarkdownTableRows(markdown)).toEqual([
      ['English', 'Meaning', 'Note'],
      ['turn | off', 'tắt', 'phrasal verb'],
      ['patient', 'kiên nhẫn', 'adjective'],
    ])
    expect(parseMarkdownText(markdown).cards).toEqual([
      { front: 'turn | off', back: 'tắt', sourceRow: 2 },
      { front: 'patient', back: 'kiên nhẫn', sourceRow: 3 },
    ])
  })

  it('extracts an HTML table without DOMParser and decodes entities', () => {
    const html = `
      <html><body>
        <table>
          <tr><th>English</th><th>Meaning</th></tr>
          <tr><td><strong>ice &amp; cream</strong></td><td>kem</td></tr>
          <tr><td>focus</td><td>tập&nbsp;trung</td></tr>
        </table>
      </body></html>
    `

    expect(extractHtmlTableRows(html)).toEqual([
      ['English', 'Meaning'],
      ['ice & cream', 'kem'],
      ['focus', 'tập trung'],
    ])
    expect(parseHtmlText(html).cards.map(({ front, back }) => [front, back])).toEqual([
      ['ice & cream', 'kem'],
      ['focus', 'tập trung'],
    ])
  })

  it('converts arrays of objects and arrays of arrays from JSON', () => {
    expect(
      jsonToRows([
        { English: 'sun', Meaning: 'mặt trời' },
        { English: 'moon', Meaning: 'mặt trăng', Note: 'noun' },
      ]),
    ).toEqual([
      ['English', 'Meaning', 'Note'],
      ['sun', 'mặt trời', ''],
      ['moon', 'mặt trăng', 'noun'],
    ])

    expect(
      parseJsonText(
        JSON.stringify([
          ['English', 'Meaning'],
          ['adapt', 'thích nghi'],
        ]),
      ).cards,
    ).toEqual([{ front: 'adapt', back: 'thích nghi', sourceRow: 2 }])
  })

  it('rejects malformed or structurally mixed JSON', () => {
    expect(() => parseJsonText('{oops')).toThrow(VocabularyParseError)
    expect(() => parseJsonText('[["word"], {"Meaning":"nghĩa"}]')).toThrow(
      VocabularyParseError,
    )
  })

  it('strips RTF controls, destinations and Unicode fallbacks', () => {
    const rtf =
      String.raw`{\rtf1\ansi\uc1{\fonttbl{\f0 Arial;}}English\tab Meaning\par apple\tab qu\u7843? t\u225?o\par focus\tab t\u7853?p trung}`

    expect(rtfToPlainText(rtf)).toBe(
      'English\tMeaning\napple\tquả táo\nfocus\ttập trung',
    )
    expect(parseRtfText(rtf).cards.map(({ front, back }) => [front, back])).toEqual([
      ['apple', 'quả táo'],
      ['focus', 'tập trung'],
    ])
  })

  it('prefers a DOCX HTML table and does not request raw text', async () => {
    let rawTextCalls = 0
    const extractor = {
      async convertToHtml() {
        return {
          value:
            '<p>ignore - bỏ qua</p><table><tr><th>English</th><th>Meaning</th></tr><tr><td>focus</td><td>tập trung</td></tr></table>',
        }
      },
      async extractRawText() {
        rawTextCalls += 1
        return { value: 'wrong\tdata' }
      },
    }

    const parsed = await parseDocx(new Blob(['docx']), extractor)

    expect(parsed.cards).toEqual([
      { front: 'focus', back: 'tập trung', sourceRow: 2 },
    ])
    expect(rawTextCalls).toBe(0)
  })

  it('falls back from DOCX tables to paired HTML paragraphs', async () => {
    const extractor = {
      async convertToHtml() {
        return {
          value:
            '<p>English</p><p>Meaning</p><p>patient</p><p>kiên nhẫn</p>',
        }
      },
      async extractRawText() {
        throw new Error('Raw text should not be needed')
      },
    }

    await expect(parseDocx(new Blob(['docx']), extractor)).resolves.toMatchObject({
      cards: [{ front: 'patient', back: 'kiên nhẫn', sourceRow: 2 }],
    })
  })

  it('uses DOCX raw text as the final fallback', async () => {
    const extractor = {
      async convertToHtml() {
        return { value: '<p>single paragraph</p>' }
      },
      async extractRawText() {
        return {
          value: 'English: Meaning\nremember: ghi nhớ',
        }
      },
    }

    await expect(parseDocx(new Blob(['docx']), extractor)).resolves.toMatchObject({
      cards: [{ front: 'remember', back: 'ghi nhớ', sourceRow: 2 }],
    })
  })

  it('lets the mapping preview override an incorrect guess', () => {
    const parsed = analyzeRows([
      ['English', 'Example', 'Meaning'],
      ['cat', 'The cat sleeps.', 'con mèo'],
    ])
    const remapped = remapColumns(parsed, {
      englishColumn: 1,
      vietnameseColumn: 2,
    })

    expect(remapped.mapping.confidence).toBe(1)
    expect(remapped.cards[0]).toMatchObject({
      front: 'The cat sleeps.',
      back: 'con mèo',
    })
  })

  it('normalizes editable and published Google Sheets links', () => {
    expect(
      normalizeGoogleSheetsUrl(
        'https://docs.google.com/spreadsheets/d/sheet-id/edit#gid=123',
      ),
    ).toBe(
      'https://docs.google.com/spreadsheets/d/sheet-id/export?format=csv&gid=123',
    )

    expect(
      normalizeGoogleSheetsUrl(
        'https://docs.google.com/spreadsheets/d/e/published-id/pubhtml?gid=7&single=true',
      ),
    ).toBe(
      'https://docs.google.com/spreadsheets/d/e/published-id/pub?output=csv&gid=7&single=true',
    )
  })

  it('downloads and parses a public Google Sheets CSV export', async () => {
    let requestedUrl = ''
    const fetcher = async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response('English,Nghĩa\nfocus,tập trung', { status: 200 })
    }

    const parsed = await parseGoogleSheet(
      'https://docs.google.com/spreadsheets/d/public-sheet/edit#gid=9',
      fetcher as typeof fetch,
    )

    expect(requestedUrl).toBe(
      'https://docs.google.com/spreadsheets/d/public-sheet/export?format=csv&gid=9',
    )
    expect(parsed.cards[0]).toMatchObject({
      front: 'focus',
      back: 'tập trung',
    })
  })

  it('detects CSV files from their extension', async () => {
    const file = Object.assign(
      new Blob(['English,Meaning\nsun,mặt trời'], { type: '' }),
      { name: 'words.csv' },
    )

    await expect(parseFile(file)).resolves.toMatchObject({
      hasHeader: true,
      cards: [{ front: 'sun', back: 'mặt trời', sourceRow: 2 }],
    })
  })

  it.each([
    ['words.tsv', 'English\tMeaning\nsun\tmặt trời'],
    ['words.txt', 'English;Meaning\nsun;mặt trời'],
    [
      'words.md',
      '| English | Meaning |\n| --- | --- |\n| sun | mặt trời |',
    ],
    ['words.markdown', 'English - Meaning\nsun - mặt trời'],
    [
      'words.json',
      '[{"English":"sun","Meaning":"mặt trời"}]',
    ],
    [
      'words.html',
      '<table><tr><th>English</th><th>Meaning</th></tr><tr><td>sun</td><td>mặt trời</td></tr></table>',
    ],
    [
      'words.htm',
      '<table><tr><th>English</th><th>Meaning</th></tr><tr><td>sun</td><td>mặt trời</td></tr></table>',
    ],
    [
      'words.rtf',
      String.raw`{\rtf1 English\tab Meaning\par sun\tab m\u7863?t tr\u7901?i}`,
    ],
  ])('routes %s through parseFile', async (name, contents) => {
    const file = Object.assign(new Blob([contents], { type: '' }), { name })

    await expect(parseFile(file)).resolves.toMatchObject({
      cards: [{ front: 'sun', back: 'mặt trời', sourceRow: 2 }],
    })
  })

  it('routes DOCX files to the injected Word extractor', async () => {
    const file = Object.assign(new Blob(['docx'], { type: '' }), {
      name: 'words.docx',
    })
    const docxExtractor = {
      async convertToHtml() {
        return {
          value:
            '<table><tr><th>English</th><th>Meaning</th></tr><tr><td>sun</td><td>mặt trời</td></tr></table>',
        }
      },
      async extractRawText() {
        return { value: '' }
      },
    }

    await expect(parseFile(file, { docxExtractor })).resolves.toMatchObject({
      cards: [{ front: 'sun', back: 'mặt trời', sourceRow: 2 }],
    })
  })

  it('reads a real DOCX table through Mammoth', async () => {
    const row = (english: string, meaning: string) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(english)] }),
          new TableCell({ children: [new Paragraph(meaning)] }),
        ],
      })
    const document = new Document({
      sections: [
        {
          children: [
            new Table({
              rows: [
                row('English', 'Meaning'),
                row('patient', 'kiên nhẫn'),
                row('adapt', 'thích nghi'),
              ],
            }),
          ],
        },
      ],
    })
    const file = Object.assign(await Packer.toBlob(document), {
      name: 'real-words.docx',
    })

    await expect(parseFile(file)).resolves.toMatchObject({
      hasHeader: true,
      cards: [
        { front: 'patient', back: 'kiên nhẫn', sourceRow: 2 },
        { front: 'adapt', back: 'thích nghi', sourceRow: 3 },
      ],
    })
  })

  it('reads a real XLSX workbook in the browser parser', async () => {
    const workbook = await writeExcelFile([
      [{ value: 'English' }, { value: 'Nghĩa' }],
      [{ value: 'patient' }, { value: 'kiên nhẫn' }],
      [{ value: 'adapt' }, { value: 'thích nghi' }],
    ]).toBlob()
    const file = Object.assign(workbook, { name: 'words.xlsx' })

    await expect(parseFile(file)).resolves.toMatchObject({
      hasHeader: true,
      cards: [
        { front: 'patient', back: 'kiên nhẫn', sourceRow: 2 },
        { front: 'adapt', back: 'thích nghi', sourceRow: 3 },
      ],
    })
  })

  it('rejects unsupported and incomplete input', async () => {
    const file = Object.assign(new Blob(['hello']), { name: 'words.pdf' })

    await expect(parseFile(file)).rejects.toBeInstanceOf(VocabularyParseError)
    expect(() => analyzeRows([['only one column']])).toThrow(
      VocabularyParseError,
    )
  })
})
