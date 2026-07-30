import Papa from 'papaparse'
import { readSheet } from 'read-excel-file/browser'

export type RawCell = string | number | boolean | Date | null | undefined
export type RawRow = readonly RawCell[]

export interface ColumnScore {
  index: number
  header: string
  englishScore: number
  vietnameseScore: number
  sampleCount: number
}

export interface ColumnMapping {
  englishColumn: number
  vietnameseColumn: number
  /**
   * A best-effort value in the 0..1 range. A low score means the mapping UI
   * should draw extra attention to the column selectors.
   */
  confidence: number
}

export interface ParsedVocabularyCard {
  front: string
  back: string
  /** One-based row number in the source file, including the header row. */
  sourceRow: number
}

export interface ParsedTable {
  /** All normalized, non-empty rows, including a detected header row. */
  rows: string[][]
  headers: string[]
  dataRows: string[][]
  hasHeader: boolean
  mapping: ColumnMapping
  columnScores: ColumnScore[]
  cards: ParsedVocabularyCard[]
  /** One-based source row numbers that could not produce a complete card. */
  skippedRows: number[]
}

export class VocabularyParseError extends Error {
  override name = 'VocabularyParseError'
}

const ENGLISH_HEADER_NAMES = new Set([
  'anh',
  'english',
  'english phrase',
  'english word',
  'front',
  'phrase',
  'term',
  'tu',
  'tu tieng anh',
  'vocab',
  'vocabulary',
  'word',
  'word phrase',
])

const VIETNAMESE_HEADER_NAMES = new Set([
  'back',
  'definition',
  'dinh nghia',
  'giai nghia',
  'meaning',
  'nghia',
  'nghia tieng viet',
  'tieng viet',
  'translation',
  'viet',
  'vietnamese',
])

const HEADERISH_PATTERN =
  /^(?:col(?:umn)?|field|cot)\s*(?:name|\d+|[a-z])$|^(?:question|answer|prompt|response)$/i

const VIETNAMESE_CHARACTER_PATTERN =
  /[ăâđêôơưĂÂĐÊÔƠƯàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/u

const VIETNAMESE_COMMON_WORD_PATTERN =
  /(?:^|\s)(?:ai|ban|bi|cai|cho|con|cua|duoc|gi|khong|la|mot|nguoi|nhung|su|toi|trong|va|ve|voi|được|không|là|một|người|những|sự|tôi|trong|và|về|với)(?:$|\s)/iu

const ASCII_ENGLISH_PATTERN = /^[A-Za-z][A-Za-z' -]*$/

function stripDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, (character) => (character === 'Đ' ? 'D' : 'd'))
}

function normalizeHeader(value: string): string {
  return stripDiacritics(value)
    .toLocaleLowerCase('vi')
    .replace(/[_/|()[\]{}:;,.!?-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeCell(value: RawCell): string {
  if (value == null) {
    return ''
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  return String(value).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
}

function normalizeRows(rows: readonly RawRow[]): string[][] {
  const normalized = rows
    .map((row) => row.map(normalizeCell))
    .filter((row) => row.some(Boolean))

  const width = normalized.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  return normalized.map((row) =>
    Array.from({ length: width }, (_, column) => row[column] ?? ''),
  )
}

function headerRole(value: string): 'english' | 'vietnamese' | 'generic' | null {
  const normalized = normalizeHeader(value)

  if (ENGLISH_HEADER_NAMES.has(normalized)) {
    return 'english'
  }

  if (VIETNAMESE_HEADER_NAMES.has(normalized)) {
    return 'vietnamese'
  }

  if (HEADERISH_PATTERN.test(normalized)) {
    return 'generic'
  }

  return null
}

export function detectHeader(rows: readonly RawRow[]): boolean {
  const normalized = normalizeRows(rows)
  const firstRow = normalized[0]

  if (!firstRow) {
    return false
  }

  const roles = firstRow.map(headerRole)
  const semanticRoles = roles.filter(
    (role): role is 'english' | 'vietnamese' =>
      role === 'english' || role === 'vietnamese',
  )

  if (new Set(semanticRoles).size >= 2) {
    return true
  }

  return roles.some(Boolean) && normalized.length > 1
}

function ratio(values: readonly string[], predicate: (value: string) => boolean): number {
  if (values.length === 0) {
    return 0
  }

  return values.filter(predicate).length / values.length
}

function scoreColumn(
  index: number,
  header: string,
  values: readonly string[],
  hasHeader: boolean,
): ColumnScore {
  const samples = values.filter(Boolean).slice(0, 80)
  const vietnameseCharacterRatio = ratio(samples, (value) =>
    VIETNAMESE_CHARACTER_PATTERN.test(value),
  )
  const vietnameseWordRatio = ratio(samples, (value) =>
    VIETNAMESE_COMMON_WORD_PATTERN.test(
      ` ${stripDiacritics(value).toLocaleLowerCase('vi')} `,
    ),
  )
  const asciiEnglishRatio = ratio(samples, (value) =>
    ASCII_ENGLISH_PATTERN.test(value),
  )
  const compactPhraseRatio = ratio(
    samples,
    (value) => value.split(/\s+/).filter(Boolean).length <= 4 && value.length <= 48,
  )
  const sentenceLikeRatio = ratio(
    samples,
    (value) => value.split(/\s+/).filter(Boolean).length >= 5 || value.length > 64,
  )

  let englishScore =
    asciiEnglishRatio * 4 +
    compactPhraseRatio * 1.6 -
    vietnameseCharacterRatio * 5 -
    sentenceLikeRatio * 0.4
  let vietnameseScore =
    vietnameseCharacterRatio * 6 +
    vietnameseWordRatio * 1.5 +
    sentenceLikeRatio * 0.35

  if (hasHeader) {
    const role = headerRole(header)
    if (role === 'english') {
      englishScore += 12
      vietnameseScore -= 4
    } else if (role === 'vietnamese') {
      vietnameseScore += 12
      englishScore -= 4
    }
  }

  return {
    index,
    header,
    englishScore: Number(englishScore.toFixed(4)),
    vietnameseScore: Number(vietnameseScore.toFixed(4)),
    sampleCount: samples.length,
  }
}

function chooseMapping(scores: readonly ColumnScore[]): ColumnMapping {
  if (scores.length < 2) {
    throw new VocabularyParseError(
      'Cần ít nhất hai cột để xác định từ tiếng Anh và nghĩa tiếng Việt.',
    )
  }

  const pairs: Array<{
    englishColumn: number
    vietnameseColumn: number
    total: number
  }> = []

  for (const english of scores) {
    for (const vietnamese of scores) {
      if (english.index === vietnamese.index) {
        continue
      }

      // Tiny left-to-right tie breaker reflects the most common word/meaning layout.
      const positionTieBreaker =
        english.index < vietnamese.index ? 0.0002 : 0.0001
      pairs.push({
        englishColumn: english.index,
        vietnameseColumn: vietnamese.index,
        total:
          english.englishScore +
          vietnamese.vietnameseScore +
          positionTieBreaker,
      })
    }
  }

  pairs.sort((left, right) => right.total - left.total)
  const best = pairs[0]
  const runnerUp = pairs[1]

  if (!best) {
    throw new VocabularyParseError('Không thể xác định cặp cột từ/nghĩa.')
  }

  const margin = best.total - (runnerUp?.total ?? 0)
  const evidence = Math.max(0, best.total)
  const confidence = Math.max(
    0,
    Math.min(1, 0.35 + margin / 10 + evidence / 45),
  )

  return {
    englishColumn: best.englishColumn,
    vietnameseColumn: best.vietnameseColumn,
    confidence: Number(confidence.toFixed(3)),
  }
}

function createCards(
  dataRows: readonly string[][],
  mapping: ColumnMapping,
  hasHeader: boolean,
): Pick<ParsedTable, 'cards' | 'skippedRows'> {
  const cards: ParsedVocabularyCard[] = []
  const skippedRows: number[] = []

  dataRows.forEach((row, index) => {
    const sourceRow = index + (hasHeader ? 2 : 1)
    const front = row[mapping.englishColumn]?.trim() ?? ''
    const back = row[mapping.vietnameseColumn]?.trim() ?? ''

    if (!front || !back) {
      skippedRows.push(sourceRow)
      return
    }

    cards.push({ front, back, sourceRow })
  })

  return { cards, skippedRows }
}

export function analyzeRows(rows: readonly RawRow[]): ParsedTable {
  const normalized = normalizeRows(rows)

  if (normalized.length === 0) {
    throw new VocabularyParseError('Tệp không có dữ liệu.')
  }

  const hasHeader = detectHeader(normalized)
  const headers = hasHeader
    ? [...normalized[0]]
    : normalized[0].map((_, index) => `Cột ${index + 1}`)
  const dataRows = hasHeader ? normalized.slice(1) : normalized

  if (dataRows.length === 0) {
    throw new VocabularyParseError('Tệp chỉ có tiêu đề, chưa có dòng từ vựng.')
  }

  const columnScores = headers.map((header, index) =>
    scoreColumn(
      index,
      header,
      dataRows.map((row) => row[index] ?? ''),
      hasHeader,
    ),
  )
  const mapping = chooseMapping(columnScores)
  const { cards, skippedRows } = createCards(dataRows, mapping, hasHeader)

  return {
    rows: normalized,
    headers,
    dataRows,
    hasHeader,
    mapping,
    columnScores,
    cards,
    skippedRows,
  }
}

export function remapColumns(
  table: ParsedTable,
  mapping: Pick<ColumnMapping, 'englishColumn' | 'vietnameseColumn'>,
): ParsedTable {
  const width = table.headers.length
  const { englishColumn, vietnameseColumn } = mapping

  if (
    englishColumn === vietnameseColumn ||
    englishColumn < 0 ||
    vietnameseColumn < 0 ||
    englishColumn >= width ||
    vietnameseColumn >= width
  ) {
    throw new VocabularyParseError('Hai cột từ/nghĩa phải khác nhau và tồn tại.')
  }

  const nextMapping: ColumnMapping = {
    englishColumn,
    vietnameseColumn,
    confidence: 1,
  }
  const { cards, skippedRows } = createCards(
    table.dataRows,
    nextMapping,
    table.hasHeader,
  )

  return {
    ...table,
    mapping: nextMapping,
    cards,
    skippedRows,
  }
}

export function parseDelimitedText(text: string, delimiter?: string): ParsedTable {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    delimiter: delimiter ?? '',
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
  })

  if (result.errors.length > 0) {
    const firstError = result.errors[0]
    throw new VocabularyParseError(
      `Không thể đọc dữ liệu phân cách: ${firstError?.message ?? 'lỗi không xác định'}`,
    )
  }

  return analyzeRows(result.data)
}

const TEXT_DELIMITER_CANDIDATES = [
  '\t',
  ',',
  ';',
  '|',
  ':',
] as const

const MARKDOWN_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/
const DASH_DELIMITER_PATTERN = /\s+(?:-|–|—)\s+/

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string, hexadecimal: string, named: string) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16)
        if (
          Number.isFinite(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
        ) {
          return String.fromCodePoint(codePoint)
        }
        return entity
      }

      return namedEntities[named.toLocaleLowerCase('en')] ?? entity
    },
  )
}

function htmlFragmentToText(fragment: string): string {
  return decodeHtmlEntities(
    fragment
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|li|p|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

function selectBestRows(candidates: readonly string[][][]): string[][] {
  return (
    [...candidates].sort((left, right) => {
      const usableDifference =
        right.filter((row) => row.filter(Boolean).length >= 2).length -
        left.filter((row) => row.filter(Boolean).length >= 2).length
      if (usableDifference !== 0) {
        return usableDifference
      }
      return right.length - left.length
    })[0] ?? []
  )
}

/**
 * Extracts the most data-like table without executing the supplied HTML.
 * This intentionally avoids DOMParser so it also works in Node-based tests.
 */
export function extractHtmlTableRows(html: string): string[][] {
  const tableMatches = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi)]
  const tableFragments =
    tableMatches.length > 0 ? tableMatches.map((match) => match[0]) : [html]
  const candidates: string[][][] = []

  for (const table of tableFragments) {
    const rows: string[][] = []
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const row: string[] = []
      const rowHtml = rowMatch[1] ?? ''
      for (const cellMatch of rowHtml.matchAll(
        /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi,
      )) {
        row.push(htmlFragmentToText(cellMatch[1] ?? ''))
      }
      if (row.length > 0) {
        rows.push(row)
      }
    }
    if (rows.some((row) => row.length >= 2)) {
      candidates.push(rows)
    }
  }

  return selectBestRows(candidates)
}

export function extractHtmlParagraphs(html: string): string[] {
  return [...html.matchAll(/<(?:p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/(?:p|li|h[1-6])\s*>/gi)]
    .map((match) => htmlFragmentToText(match[1] ?? ''))
    .filter(Boolean)
}

function splitMarkdownTableRow(line: string): string[] {
  let source = line.trim()
  if (source.startsWith('|')) {
    source = source.slice(1)
  }
  if (source.endsWith('|') && !source.endsWith('\\|')) {
    source = source.slice(0, -1)
  }

  const cells: string[] = []
  let current = ''
  let escaped = false

  for (const character of source) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells.push(current)
      current = ''
    } else {
      current += character
    }
  }
  current += escaped ? '\\' : ''
  cells.push(current)

  return cells.map((cell) =>
    htmlFragmentToText(
      cell
        .trim()
        .replace(/^`(.+)`$/, '$1')
        .replace(/^(?:\*\*|__)(.+)(?:\*\*|__)$/, '$1'),
    ),
  )
}

function isMarkdownSeparatorRow(line: string, expectedWidth: number): boolean {
  const cells = splitMarkdownTableRow(line)
  return (
    cells.length === expectedWidth &&
    cells.length >= 2 &&
    cells.every((cell) => MARKDOWN_SEPARATOR_CELL_PATTERN.test(cell))
  )
}

export function extractMarkdownTableRows(markdown: string): string[][] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/)
  const candidates: string[][][] = []

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index] ?? ''
    if (!headerLine.includes('|')) {
      continue
    }

    const header = splitMarkdownTableRow(headerLine)
    if (!isMarkdownSeparatorRow(lines[index + 1] ?? '', header.length)) {
      continue
    }

    const rows = [header]
    let rowIndex = index + 2
    while (rowIndex < lines.length && (lines[rowIndex] ?? '').includes('|')) {
      const row = splitMarkdownTableRow(lines[rowIndex] ?? '')
      if (row.length !== header.length) {
        break
      }
      rows.push(row)
      rowIndex += 1
    }
    candidates.push(rows)
    index = rowIndex - 1
  }

  return selectBestRows(candidates)
}

function parseRowsWithDelimiter(text: string, delimiter: string): string[][] {
  if (delimiter === '|') {
    return text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map(splitMarkdownTableRow)
  }

  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    delimiter,
    dynamicTyping: false,
    skipEmptyLines: 'greedy',
  })
  return result.errors.length === 0 ? result.data : []
}

function parseRowsWithDash(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      if (DASH_DELIMITER_PATTERN.test(line)) {
        return line.split(DASH_DELIMITER_PATTERN).map((cell) => cell.trim())
      }

      const bareDashes = line.match(/[-–—]/g)
      return bareDashes?.length === 1
        ? line.split(/[-–—]/).map((cell) => cell.trim())
        : [line.trim()]
    })
}

function scoreDelimitedRows(rows: readonly string[][]): number {
  if (rows.length === 0) {
    return 0
  }

  const usableRows = rows.filter((row) => row.length >= 2)
  if (usableRows.length === 0) {
    return 0
  }

  const widthFrequency = new Map<number, number>()
  for (const row of usableRows) {
    widthFrequency.set(row.length, (widthFrequency.get(row.length) ?? 0) + 1)
  }
  const mostCommonWidthCount = Math.max(...widthFrequency.values())
  const coverage = usableRows.length / rows.length
  const consistency = mostCommonWidthCount / usableRows.length

  return coverage * 10 + consistency * 5 + Math.min(usableRows[0]?.length ?? 0, 4)
}

export function flexibleTextToRows(text: string): string[][] {
  const candidates = TEXT_DELIMITER_CANDIDATES.map((delimiter, priority) => {
    const rows = parseRowsWithDelimiter(text, delimiter)
    return {
      priority,
      rows,
      score: scoreDelimitedRows(rows),
    }
  })
  const dashRows = parseRowsWithDash(text)
  candidates.push({
    priority: TEXT_DELIMITER_CANDIDATES.length,
    rows: dashRows,
    score: scoreDelimitedRows(dashRows),
  })

  const best = candidates.sort(
    (left, right) => right.score - left.score || left.priority - right.priority,
  )[0]

  if (best && best.score > 0) {
    return best.rows
  }

  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => [line.trim()])
    .filter((row) => Boolean(row[0]))
}

export function parseFlexibleText(text: string): ParsedTable {
  return analyzeRows(flexibleTextToRows(text))
}

function pairTextBlocks(blocks: readonly string[]): string[][] {
  const rows: string[][] = []
  for (let index = 0; index < blocks.length; index += 2) {
    rows.push([blocks[index] ?? '', blocks[index + 1] ?? ''])
  }
  return rows
}

function tryAnalyzeRows(rows: readonly RawRow[]): ParsedTable | null {
  try {
    return analyzeRows(rows)
  } catch {
    return null
  }
}

function parseTextBlocks(blocks: readonly string[]): ParsedTable | null {
  if (blocks.length === 0) {
    return null
  }

  const delimited = tryAnalyzeRows(flexibleTextToRows(blocks.join('\n')))
  if (delimited) {
    return delimited
  }

  return blocks.length >= 2 ? tryAnalyzeRows(pairTextBlocks(blocks)) : null
}

export function parseHtmlText(html: string): ParsedTable {
  const table = tryAnalyzeRows(extractHtmlTableRows(html))
  if (table) {
    return table
  }

  const paragraphs = parseTextBlocks(extractHtmlParagraphs(html))
  if (paragraphs) {
    return paragraphs
  }

  return parseFlexibleText(htmlFragmentToText(html))
}

export function parseMarkdownText(markdown: string): ParsedTable {
  const table = tryAnalyzeRows(extractMarkdownTableRows(markdown))
  if (table) {
    return table
  }

  const plainText = markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
  return parseFlexibleText(plainText)
}

function jsonCellToRawCell(value: unknown): RawCell {
  if (value == null) {
    return ''
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  return JSON.stringify(value)
}

export function jsonToRows(value: unknown): RawRow[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new VocabularyParseError(
      'JSON phải là một mảng không rỗng gồm các hàng hoặc các đối tượng.',
    )
  }

  if (value.every(Array.isArray)) {
    return value.map((row) => row.map(jsonCellToRawCell))
  }

  if (
    value.every(
      (row) => typeof row === 'object' && row !== null && !Array.isArray(row),
    )
  ) {
    const records = value as Array<Record<string, unknown>>
    const headers = [
      ...new Set(records.flatMap((record) => Object.keys(record))),
    ]
    return [
      headers,
      ...records.map((record) =>
        headers.map((header) => jsonCellToRawCell(record[header])),
      ),
    ]
  }

  throw new VocabularyParseError(
    'Các phần tử JSON phải cùng là mảng hoặc cùng là đối tượng.',
  )
}

export function parseJsonText(text: string): ParsedTable {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new VocabularyParseError('Tệp JSON không hợp lệ.')
  }
  return analyzeRows(jsonToRows(value))
}

const RTF_DESTINATIONS = new Set([
  'colortbl',
  'datastore',
  'filetbl',
  'fonttbl',
  'footer',
  'footerf',
  'footerl',
  'footerr',
  'header',
  'headerf',
  'headerl',
  'headerr',
  'info',
  'listoverridetable',
  'listtable',
  'object',
  'pict',
  'stylesheet',
  'themedata',
  'xmlnstbl',
])

const WINDOWS_1252_CHARACTERS: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
}

function decodeWindows1252Byte(value: number): string {
  return WINDOWS_1252_CHARACTERS[value] ?? String.fromCharCode(value)
}

interface RtfState {
  skip: boolean
  unicodeFallbackLength: number
}

export function rtfToPlainText(rtf: string): string {
  let state: RtfState = { skip: false, unicodeFallbackLength: 1 }
  const stack: RtfState[] = []
  let output = ''
  let index = 0
  let fallbackCharactersToSkip = 0

  const append = (value: string) => {
    if (fallbackCharactersToSkip > 0) {
      fallbackCharactersToSkip -= 1
    } else if (!state.skip) {
      output += value
    }
  }

  while (index < rtf.length) {
    const character = rtf[index] ?? ''

    if (character === '{') {
      stack.push(state)
      state = { ...state }
      index += 1
      continue
    }

    if (character === '}') {
      state = stack.pop() ?? state
      index += 1
      continue
    }

    if (character !== '\\') {
      if (character !== '\r' && character !== '\n') {
        append(character)
      }
      index += 1
      continue
    }

    const next = rtf[index + 1] ?? ''
    if (next === '\\' || next === '{' || next === '}') {
      append(next)
      index += 2
      continue
    }

    if (next === "'" && /^[\da-f]{2}$/i.test(rtf.slice(index + 2, index + 4))) {
      append(decodeWindows1252Byte(Number.parseInt(rtf.slice(index + 2, index + 4), 16)))
      index += 4
      continue
    }

    if (next === '*') {
      state.skip = true
      index += 2
      continue
    }

    if (!/[a-z]/i.test(next)) {
      if (next === '~') {
        append(' ')
      } else if (next === '_') {
        append('-')
      }
      index += 2
      continue
    }

    const controlMatch = rtf
      .slice(index + 1)
      .match(/^([a-z]+)(-?\d+)? ?/i)
    if (!controlMatch) {
      index += 1
      continue
    }

    const word = (controlMatch[1] ?? '').toLocaleLowerCase('en')
    const parameter =
      controlMatch[2] === undefined ? null : Number.parseInt(controlMatch[2], 10)
    index += 1 + controlMatch[0].length

    if (RTF_DESTINATIONS.has(word)) {
      state.skip = true
    } else if (word === 'uc' && parameter !== null) {
      state.unicodeFallbackLength = Math.max(0, parameter)
    } else if (word === 'u' && parameter !== null) {
      if (!state.skip) {
        output += String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter)
      }
      fallbackCharactersToSkip = state.unicodeFallbackLength
    } else if (word === 'par' || word === 'line' || word === 'row') {
      append('\n')
    } else if (word === 'tab' || word === 'cell') {
      append('\t')
    }
  }

  return output
    .replace(/\u00a0/g, ' ')
    .replace(/[^\S\n\t]+/g, ' ')
    .replace(/ *\t */g, '\t')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function parseRtfText(rtf: string): ParsedTable {
  return parseFlexibleText(rtfToPlainText(rtf))
}

export interface DocxExtractor {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
  extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
}

export async function parseDocx(
  file: File | Blob,
  extractor?: DocxExtractor,
): Promise<ParsedTable> {
  const activeExtractor: DocxExtractor =
    extractor ?? (await import('mammoth')).default
  let arrayBuffer: ArrayBuffer
  try {
    arrayBuffer = await file.arrayBuffer()
  } catch {
    throw new VocabularyParseError('Không thể đọc dữ liệu trong tệp Word.')
  }
  // Mammoth's browser entry reads `arrayBuffer`, while its Node entry (used by
  // Vitest and SSR) reads `buffer`. Supplying both keeps the parser portable.
  const mammothInput = { arrayBuffer, buffer: arrayBuffer }

  try {
    const html = (await activeExtractor.convertToHtml(mammothInput)).value
    const table = tryAnalyzeRows(extractHtmlTableRows(html))
    if (table) {
      return table
    }

    const paragraphs = parseTextBlocks(extractHtmlParagraphs(html))
    if (paragraphs) {
      return paragraphs
    }
  } catch {
    // Raw text extraction below is the final fallback for malformed HTML output.
  }

  try {
    const rawText = (await activeExtractor.extractRawText(mammothInput)).value
    const parsed = parseTextBlocks(
      rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    if (parsed) {
      return parsed
    }
  } catch {
    // The consistent parse error below is more useful than Mammoth internals.
  }

  throw new VocabularyParseError(
    'Không tìm thấy bảng từ vựng hợp lệ trong tệp Word.',
  )
}

export async function parseWorkbook(file: File | Blob): Promise<ParsedTable> {
  try {
    const rows = await readSheet(file)
    return analyzeRows(rows as unknown as RawRow[])
  } catch (error) {
    if (error instanceof VocabularyParseError) {
      throw error
    }

    const message = error instanceof Error ? error.message : 'lỗi không xác định'
    throw new VocabularyParseError(`Không thể đọc tệp Excel: ${message}`)
  }
}

function getFileName(file: File | (Blob & { name?: string })): string {
  return 'name' in file && typeof file.name === 'string' ? file.name : ''
}

export async function parseFile(
  file: File | (Blob & { name?: string }),
  options: { docxExtractor?: DocxExtractor } = {},
): Promise<ParsedTable> {
  const name = getFileName(file)
  const extension = name.split('.').pop()?.toLocaleLowerCase('en') ?? ''
  const mimeType = file.type.toLocaleLowerCase('en')

  if (
    extension === 'xlsx' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return parseWorkbook(file)
  }

  if (
    extension === 'docx' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return parseDocx(file, options.docxExtractor)
  }

  const text = await file.text()

  if (
    extension === 'json' ||
    mimeType === 'application/json' ||
    mimeType === 'text/json'
  ) {
    return parseJsonText(text)
  }

  if (
    extension === 'html' ||
    extension === 'htm' ||
    mimeType === 'text/html' ||
    mimeType === 'application/xhtml+xml'
  ) {
    return parseHtmlText(text)
  }

  if (
    extension === 'md' ||
    extension === 'markdown' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/x-markdown'
  ) {
    return parseMarkdownText(text)
  }

  if (
    extension === 'rtf' ||
    mimeType === 'application/rtf' ||
    mimeType === 'text/rtf'
  ) {
    return parseRtfText(text)
  }

  if (
    extension === 'tsv' ||
    mimeType === 'text/tab-separated-values'
  ) {
    return parseDelimitedText(text, '\t')
  }

  if (
    extension === 'csv' ||
    mimeType === 'text/csv'
  ) {
    return parseDelimitedText(text)
  }

  if (
    extension === 'txt' ||
    mimeType === 'text/plain'
  ) {
    return parseFlexibleText(text)
  }

  throw new VocabularyParseError(
    'Định dạng chưa được hỗ trợ. Hãy chọn .xlsx, .csv, .tsv, .txt, .docx, .md, .json, .html hoặc .rtf.',
  )
}

function extractHashParameters(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, '').replace(/^.*\?/, ''))
}

export function isGoogleSheetsUrl(input: string): boolean {
  try {
    const url = new URL(input.trim())
    return (
      url.hostname === 'docs.google.com' &&
      /\/spreadsheets\/(?:u\/\d+\/)?d\//.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function normalizeGoogleSheetsUrl(input: string): string {
  let url: URL

  try {
    url = new URL(input.trim())
  } catch {
    throw new VocabularyParseError('Link Google Sheets không hợp lệ.')
  }

  if (url.hostname !== 'docs.google.com') {
    throw new VocabularyParseError('Đây không phải link Google Sheets.')
  }

  const match = url.pathname.match(
    /\/spreadsheets\/(?:u\/\d+\/)?d\/(e\/)?([^/]+)/,
  )

  if (!match?.[2]) {
    throw new VocabularyParseError('Không tìm thấy mã bảng tính trong link.')
  }

  const isPublished = Boolean(match[1])
  const spreadsheetId = match[2]
  const hashParameters = extractHashParameters(url.hash)
  const gid = url.searchParams.get('gid') ?? hashParameters.get('gid')
  const single = url.searchParams.get('single')

  const exportUrl = isPublished
    ? new URL(
        `https://docs.google.com/spreadsheets/d/e/${spreadsheetId}/pub`,
      )
    : new URL(
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`,
      )

  if (isPublished) {
    exportUrl.searchParams.set('output', 'csv')
  } else {
    exportUrl.searchParams.set('format', 'csv')
  }

  if (gid) {
    exportUrl.searchParams.set('gid', gid)
  }
  if (single) {
    exportUrl.searchParams.set('single', single)
  }

  return exportUrl.toString()
}

export async function parseGoogleSheet(
  input: string,
  fetcher: typeof fetch = fetch,
): Promise<ParsedTable> {
  const exportUrl = normalizeGoogleSheetsUrl(input)
  let response: Response

  try {
    response = await fetcher(exportUrl)
  } catch {
    throw new VocabularyParseError(
      'Không thể tải Google Sheets. Hãy kiểm tra kết nối và quyền chia sẻ công khai.',
    )
  }

  if (!response.ok) {
    throw new VocabularyParseError(
      `Google Sheets trả về lỗi ${response.status}. Hãy bật quyền xem bằng link.`,
    )
  }

  return parseDelimitedText(await response.text())
}
