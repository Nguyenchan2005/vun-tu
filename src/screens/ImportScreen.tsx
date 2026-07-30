import { useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Braces,
  CalendarDays,
  Check,
  ChevronRight,
  Cloud,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderOpen,
  FolderPlus,
  Link,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
  Table2,
  X,
} from 'lucide-react'

import {
  parseFile,
  parseGoogleSheet,
  remapColumns,
  type ColumnMapping,
  type ParsedTable,
} from '../lib/parser'
import {
  formatFileSize,
  makeDatedDeckName,
} from '../lib/format'
import type {
  DeckSummary,
  ImportSource,
  NewCardInput,
  StudyDirection,
} from '../models'

type ImportStep = 1 | 2 | 3 | 4
type SourceTab = 'file' | 'google'
type FolderMode = 'custom' | 'date' | 'existing'

export interface ImportSavePayload {
  target:
    | {
        kind: 'new'
        name: string
        preferredDirection: StudyDirection
        sourceName: string
        sourceType: ImportSource
      }
    | { kind: 'existing'; deckId: string }
  cards: NewCardInput[]
}

interface ImportSaveResult {
  deckId: string
  deckName: string
  importedCount: number
  skippedCount: number
}

interface ImportScreenProps {
  decks: DeckSummary[]
  onSave: (payload: ImportSavePayload) => Promise<ImportSaveResult>
  onStudy: (deckId: string) => void
  onHome: () => void
}

const FILE_ACCEPT =
  '.xlsx,.csv,.tsv,.txt,.docx,.md,.markdown,.json,.html,.htm,.rtf'

const FORMAT_LABELS = [
  ['XLSX', FileSpreadsheet],
  ['DOCX', FileText],
  ['CSV · TSV · TXT', Table2],
  ['JSON', Braces],
  ['MD · HTML · RTF', FileText],
] as const

function inferSourceType(filename: string): ImportSource {
  const extension = filename.split('.').pop()?.toLocaleLowerCase()
  if (extension === 'xlsx') return 'xlsx'
  if (extension === 'docx') return 'docx'
  if (extension === 'tsv') return 'tsv'
  if (extension === 'json') return 'json'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'rtf') return 'rtf'
  if (extension === 'txt') return 'txt'
  return 'csv'
}

function extensionLabel(filename: string): string {
  return filename.split('.').pop()?.toLocaleUpperCase() || 'TỆP'
}

export function ImportScreen({
  decks,
  onSave,
  onStudy,
  onHome,
}: ImportScreenProps) {
  const [step, setStep] = useState<ImportStep>(1)
  const [folderMode, setFolderMode] = useState<FolderMode>('date')
  const [folderName, setFolderName] = useState('')
  const [existingDeckId, setExistingDeckId] = useState(decks[0]?.id ?? '')
  const [sourceTab, setSourceTab] = useState<SourceTab>('file')
  const [file, setFile] = useState<File | null>(null)
  const [sheetUrl, setSheetUrl] = useState('')
  const [parsed, setParsed] = useState<ParsedTable | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [direction, setDirection] = useState<StudyDirection>('en-vi')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportSaveResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const datedName = makeDatedDeckName()
  const destinationName =
    folderMode === 'custom'
      ? folderName.trim()
      : folderMode === 'date'
        ? datedName
        : decks.find((deck) => deck.id === existingDeckId)?.name ?? ''
  const sourceName = file?.name ?? 'Google Sheets'
  const sourceType: ImportSource =
    sourceTab === 'google'
      ? 'google-sheets'
      : inferSourceType(file?.name ?? '')

  const remapped = useMemo(() => {
    if (!parsed || !mapping) return null
    return remapColumns(parsed, mapping)
  }, [mapping, parsed])

  const canContinueFolder =
    folderMode === 'date' ||
    (folderMode === 'custom' && folderName.trim().length > 0) ||
    (folderMode === 'existing' && existingDeckId.length > 0)
  const canContinueMapping =
    mapping !== null &&
    mapping.englishColumn !== mapping.vietnameseColumn &&
    (remapped?.cards.length ?? 0) > 0

  async function loadFile(selectedFile: File) {
    if (selectedFile.size > 15 * 1_024 * 1_024) {
      setError('Tệp lớn hơn 15 MB. Hãy chia danh sách thành các tệp nhỏ hơn.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const table = await parseFile(selectedFile)
      setFile(selectedFile)
      setParsed(table)
      setMapping(table.mapping)
      setStep(3)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Không đọc được tệp này. Hãy thử lưu lại bằng mã hóa UTF-8.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadGoogleSheet() {
    if (!sheetUrl.trim()) return
    setLoading(true)
    setError('')
    try {
      const table = await parseGoogleSheet(sheetUrl)
      setFile(null)
      setParsed(table)
      setMapping(table.mapping)
      setStep(3)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Không đọc được Google Sheets. Hãy kiểm tra quyền chia sẻ.',
      )
    } finally {
      setLoading(false)
    }
  }

  function updateColumn(
    key: 'englishColumn' | 'vietnameseColumn',
    value: number,
  ) {
    if (!mapping) return
    setMapping({ ...mapping, [key]: value, confidence: 1 })
  }

  function swapColumns() {
    if (!mapping) return
    setMapping({
      englishColumn: mapping.vietnameseColumn,
      vietnameseColumn: mapping.englishColumn,
      confidence: 1,
    })
  }

  async function saveImport() {
    if (!remapped || !destinationName) return
    setSaving(true)
    setError('')
    try {
      const cards: NewCardInput[] = remapped.cards.map((card) => ({
        front: card.front,
        back: card.back,
        sourceRow: card.sourceRow,
      }))
      const saved = await onSave({
        target:
          folderMode === 'existing'
            ? { kind: 'existing', deckId: existingDeckId }
            : {
                kind: 'new',
                name: destinationName,
                preferredDirection: direction,
                sourceName,
                sourceType,
              },
        cards,
      })
      setResult(saved)
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : 'Không thể lưu dữ liệu trên thiết bị này.',
      )
    } finally {
      setSaving(false)
    }
  }

  if (result) {
    return (
      <section className="page import-success" data-testid="import-success">
        <div className="success-confetti" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="success-mark">
          <Check />
        </div>
        <p className="eyebrow">ĐÃ LƯU THEO NGUỒN TỆP</p>
        <h1>Thư mục mới đã sẵn sàng.</h1>
        <p>
          Đã thêm <strong>{result.importedCount} thẻ</strong> từ{' '}
          <strong>{sourceName}</strong> vào “{result.deckName}”.
          {result.skippedCount > 0 &&
            ` ${result.skippedCount} dòng trùng đã được bỏ qua.`}
        </p>
        <div className="success-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={() => onStudy(result.deckId)}
          >
            Học ngay
            <ArrowRight />
          </button>
          <button className="button button-ghost" type="button" onClick={onHome}>
            Về trang chủ
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="page import-page import-page-v2" data-testid="import-screen">
      <ImportProgress step={step} onBackToStep={setStep} />

      {step === 1 && (
        <div className="import-stage folder-stage">
          <div className="import-heading">
            <p className="eyebrow">CẤT GỌN TRƯỚC KHI NHẬP</p>
            <h1>Bạn muốn tạo thư mục nào?</h1>
            <p>
              Đặt tên theo ý bạn. Nếu bỏ qua, Vun Từ sẽ dùng ngày nhập hôm nay.
            </p>
          </div>

          <div className="folder-choice-grid">
            <button
              className={`folder-choice ${
                folderMode === 'custom' ? 'is-selected' : ''
              }`}
              type="button"
              onClick={() => setFolderMode('custom')}
              data-testid="folder-mode-custom"
            >
              <span className="folder-choice-icon">
                <FolderPlus />
              </span>
              <span>
                <strong>Tạo thư mục và đặt tên</strong>
                <small>Dùng một tên riêng bạn dễ nhớ</small>
              </span>
              <i>{folderMode === 'custom' && <Check />}</i>
            </button>

            <button
              className={`folder-choice ${
                folderMode === 'date' ? 'is-selected' : ''
              }`}
              type="button"
              onClick={() => setFolderMode('date')}
              data-testid="folder-mode-date"
            >
              <span className="folder-choice-icon is-date">
                <CalendarDays />
              </span>
              <span>
                <strong>Không cần đặt tên</strong>
                <small>Tự lưu là “{datedName}”</small>
              </span>
              <i>{folderMode === 'date' && <Check />}</i>
            </button>

            {decks.length > 0 && (
              <button
                className={`folder-choice ${
                  folderMode === 'existing' ? 'is-selected' : ''
                }`}
                type="button"
                onClick={() => setFolderMode('existing')}
                data-testid="folder-mode-existing"
              >
                <span className="folder-choice-icon is-existing">
                  <FolderOpen />
                </span>
                <span>
                  <strong>Thêm vào thư mục có sẵn</strong>
                  <small>Gộp với một danh sách đã nhập trước đó</small>
                </span>
                <i>{folderMode === 'existing' && <Check />}</i>
              </button>
            )}
          </div>

          {folderMode === 'custom' && (
            <label className="folder-name-box">
              <span>Tên thư mục mới</span>
              <input
                type="text"
                value={folderName}
                maxLength={80}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="Ví dụ: IELTS tháng 8"
                autoFocus
                data-testid="folder-name-input"
              />
              <small>{folderName.length}/80 ký tự</small>
            </label>
          )}

          {folderMode === 'existing' && (
            <label className="folder-name-box">
              <span>Chọn thư mục</span>
              <select
                value={existingDeckId}
                onChange={(event) => setExistingDeckId(event.target.value)}
              >
                {decks.map((deck) => (
                  <option value={deck.id} key={deck.id}>
                    {deck.name} · {deck.cardCount} thẻ
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="import-source-promise">
            <ShieldCheck />
            <div>
              <strong>Không tự phân loại theo ngữ cảnh</strong>
              <span>
                Thẻ sẽ được tạo từ đúng tệp bạn tải lên; tên file gốc luôn được
                giữ làm nguồn.
              </span>
            </div>
          </div>

          <div className="stage-actions stage-actions-forward">
            <span />
            <button
              className="button button-primary"
              type="button"
              disabled={!canContinueFolder}
              onClick={() => setStep(2)}
            >
              Tiếp theo: chọn tệp
              <ArrowRight />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="import-stage source-stage">
          <DestinationRibbon
            name={destinationName}
            mode={folderMode}
            onEdit={() => setStep(1)}
          />
          <div className="import-heading">
            <p className="eyebrow">CHỌN NGUỒN DỮ LIỆU</p>
            <h1>Tải danh sách của bạn lên.</h1>
            <p>
              Bảng tính, Word hay văn bản — app sẽ thử nhận diện cấu trúc tự
              động.
            </p>
          </div>

          <div className="source-tabs source-tabs-wide" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sourceTab === 'file'}
              className={sourceTab === 'file' ? 'is-active' : ''}
              onClick={() => setSourceTab('file')}
            >
              <FileSpreadsheet />
              Tệp trên máy
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceTab === 'google'}
              className={sourceTab === 'google' ? 'is-active' : ''}
              onClick={() => setSourceTab('google')}
            >
              <Cloud />
              Google Sheets
            </button>
          </div>

          {sourceTab === 'file' ? (
            <>
              <div
                className={`dropzone dropzone-v2 ${
                  dragging ? 'is-dragging' : ''
                }`}
                onDragEnter={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  const selectedFile = event.dataTransfer.files[0]
                  if (selectedFile) void loadFile(selectedFile)
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept={FILE_ACCEPT}
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0]
                    if (selectedFile) void loadFile(selectedFile)
                  }}
                  data-testid="import-file-input"
                />
                <div className="dropzone-icon">
                  {loading ? <LoaderCircle className="spin" /> : <FileUp />}
                </div>
                <h2>{loading ? 'Đang đọc cấu trúc…' : 'Thả tệp vào vùng này'}</h2>
                <p>
                  {loading
                    ? 'Vun Từ đang tìm cột tiếng Anh và nghĩa tiếng Việt.'
                    : 'hoặc chọn một tệp trên thiết bị'}
                </p>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={loading}
                >
                  Chọn tệp để đọc
                </button>
                <span>Tối đa 15 MB · dữ liệu được xử lý ngay trên máy</span>
              </div>
              <div className="format-cloud" aria-label="Các định dạng hỗ trợ">
                {FORMAT_LABELS.map(([label, Icon]) => (
                  <span key={label}>
                    <Icon />
                    {label}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="google-source google-source-v2 paper-panel">
              <div className="google-source-icon">
                <Link />
              </div>
              <label>
                <span>Liên kết Google Sheets công khai</span>
                <input
                  type="url"
                  value={sheetUrl}
                  onChange={(event) => setSheetUrl(event.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                />
              </label>
              <p>
                Bảng cần có quyền “Bất kỳ ai có liên kết đều có thể xem”.
              </p>
              <button
                className="button button-primary"
                type="button"
                disabled={loading || !sheetUrl.trim()}
                onClick={() => void loadGoogleSheet()}
              >
                {loading ? <LoaderCircle className="spin" /> : <Table2 />}
                Đọc bảng tính
              </button>
            </div>
          )}
          <ErrorMessage message={error} onClose={() => setError('')} />
          <div className="stage-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setStep(1)}
            >
              <ArrowLeft />
              Quay lại thư mục
            </button>
          </div>
        </div>
      )}

      {step === 3 && parsed && mapping && remapped && (
        <div className="import-stage import-mapping">
          <DestinationRibbon
            name={destinationName}
            mode={folderMode}
            source={file}
            onEdit={() => setStep(2)}
          />
          <div className="import-heading">
            <p className="eyebrow">XEM TRƯỚC KHI NHẬP</p>
            <h1>Hai mặt thẻ đã đúng chưa?</h1>
            <p>
              App chỉ gợi ý mapping, không thay đổi dữ liệu gốc. Bạn có thể
              chọn lại bất kỳ lúc nào.
            </p>
          </div>

          <div
            className={`detection-banner ${
              mapping.confidence >= 0.65 ? 'is-confident' : 'is-uncertain'
            }`}
          >
            {mapping.confidence >= 0.65 ? <Check /> : <Table2 />}
            <span>
              {mapping.confidence >= 0.65
                ? `Đã nhận diện hai cột chính từ ${sourceName}`
                : 'Vun Từ chưa chắc về cách ghép cột. Bạn kiểm tra giúp nhé.'}
            </span>
          </div>

          <div className="mapping-controls paper-panel">
            <ColumnSelect
              label="Mặt tiếng Anh"
              value={mapping.englishColumn}
              headers={parsed.headers}
              disabledColumn={mapping.vietnameseColumn}
              onChange={(value) => updateColumn('englishColumn', value)}
            />
            <button
              className="swap-button"
              type="button"
              onClick={swapColumns}
              aria-label="Đổi hai mặt thẻ"
            >
              <ArrowLeftRight />
            </button>
            <ColumnSelect
              label="Mặt tiếng Việt"
              value={mapping.vietnameseColumn}
              headers={parsed.headers}
              disabledColumn={mapping.englishColumn}
              onChange={(value) => updateColumn('vietnameseColumn', value)}
            />
          </div>

          <div className="preview-panel preview-panel-v2">
            <div className="preview-heading">
              <div>
                <h2>Xem trước {Math.min(remapped.cards.length, 8)} thẻ đầu</h2>
                <p>
                  {remapped.cards.length} dòng hợp lệ ·{' '}
                  {remapped.skippedRows.length} dòng chưa đủ hai mặt
                </p>
              </div>
              <span>
                {parsed.hasHeader ? 'Có tiêu đề cột' : 'Không có tiêu đề'}
              </span>
            </div>
            <div className="preview-table-wrap">
              <table className="preview-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Mặt tiếng Anh</th>
                    <th>Mặt tiếng Việt</th>
                  </tr>
                </thead>
                <tbody>
                  {remapped.cards.slice(0, 8).map((card, index) => (
                    <tr key={`${card.sourceRow}-${index}`}>
                      <td>{String(index + 1).padStart(2, '0')}</td>
                      <td data-label="Mặt tiếng Anh">{card.front}</td>
                      <td data-label="Mặt tiếng Việt">{card.back}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="preview-helper">
              Nếu app đoán sai, chỉ cần chọn lại hai cột phía trên.
            </p>
          </div>

          <div className="stage-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setStep(2)}
            >
              <ArrowLeft />
              Chọn tệp khác
            </button>
            <button
              className="button button-primary"
              type="button"
              disabled={!canContinueMapping}
              onClick={() => setStep(4)}
            >
              Tiếp tục với {remapped.cards.length} thẻ
              <ArrowRight />
            </button>
          </div>
        </div>
      )}

      {step === 4 && parsed && remapped && (
        <div className="import-stage confirm-stage">
          <div className="import-heading">
            <p className="eyebrow">SẴN SÀNG LƯU</p>
            <h1>Mọi thứ đã vào đúng chỗ.</h1>
            <p>Chọn hướng học đầu tiên rồi xác nhận nhập vào thư mục.</p>
          </div>

          <div className="confirm-layout">
            <div className="confirm-main">
              {folderMode !== 'existing' && (
                <fieldset className="direction-options direction-options-v2">
                  <legend>Mặt nào sẽ hiện trước?</legend>
                  {(
                    [
                      ['en-vi', 'Anh → Việt', 'Nhìn từ, nhớ nghĩa'],
                      ['vi-en', 'Việt → Anh', 'Nhìn nghĩa, gọi lại từ'],
                      ['random', 'Ngẫu nhiên', 'Luân phiên cả hai hướng'],
                    ] as const
                  ).map(([value, title, description]) => (
                    <label
                      className={direction === value ? 'is-selected' : ''}
                      key={value}
                    >
                      <input
                        type="radio"
                        name="direction"
                        value={value}
                        checked={direction === value}
                        onChange={() => setDirection(value)}
                      />
                      <strong>{title}</strong>
                      <span>{description}</span>
                      {direction === value && <Check />}
                    </label>
                  ))}
                </fieldset>
              )}

              <div className="confirm-trust">
                <Sparkles />
                <div>
                  <strong>Chỉ lưu những gì bạn vừa kiểm tra</strong>
                  <span>
                    {remapped.skippedRows.length > 0
                      ? `${remapped.skippedRows.length} dòng thiếu dữ liệu sẽ không được nhập.`
                      : 'Tất cả các dòng đều có đủ hai mặt thẻ.'}
                  </span>
                </div>
              </div>
            </div>

            <aside className="import-summary import-summary-v2 paper-note">
              <p className="eyebrow">LẦN NHẬP NÀY</p>
              <dl>
                <div>
                  <dt>Thư mục</dt>
                  <dd>{destinationName}</dd>
                </div>
                <div>
                  <dt>File nguồn</dt>
                  <dd>{sourceName}</dd>
                </div>
                <div>
                  <dt>Định dạng</dt>
                  <dd>
                    {file ? extensionLabel(file.name) : 'GOOGLE SHEETS'}
                  </dd>
                </div>
                <div>
                  <dt>Ghép cột</dt>
                  <dd>
                    {parsed.headers[remapped.mapping.englishColumn]} →{' '}
                    {parsed.headers[remapped.mapping.vietnameseColumn]}
                  </dd>
                </div>
                <div>
                  <dt>Thẻ hợp lệ</dt>
                  <dd>{remapped.cards.length}</dd>
                </div>
              </dl>
            </aside>
          </div>

          <ErrorMessage message={error} onClose={() => setError('')} />
          <div className="stage-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={() => setStep(3)}
            >
              <ArrowLeft />
              Kiểm tra lại
            </button>
            <button
              className="button button-primary button-save-import"
              type="button"
              disabled={saving || remapped.cards.length === 0}
              onClick={() => void saveImport()}
            >
              {saving ? <LoaderCircle className="spin" /> : <Check />}
              Lưu {remapped.cards.length} thẻ vào “{destinationName}”
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function ImportProgress({
  step,
  onBackToStep,
}: {
  step: ImportStep
  onBackToStep: (step: ImportStep) => void
}) {
  const items = [
    ['Thư mục', 1],
    ['Chọn tệp', 2],
    ['Kiểm tra', 3],
    ['Xác nhận', 4],
  ] as const
  return (
    <nav className="import-progress import-progress-v2" aria-label="Tiến trình nhập">
      {items.map(([label, itemStep], index) => (
        <div key={label}>
          {index > 0 && <ChevronRight aria-hidden="true" />}
          <button
            type="button"
            className={step === itemStep ? 'is-active' : ''}
            disabled={itemStep > step}
            onClick={() => onBackToStep(itemStep)}
            aria-current={step === itemStep ? 'step' : undefined}
          >
            <span>{step > itemStep ? <Check /> : itemStep}</span>
            {label}
          </button>
        </div>
      ))}
    </nav>
  )
}

function DestinationRibbon({
  name,
  mode,
  source,
  onEdit,
}: {
  name: string
  mode: FolderMode
  source?: File | null
  onEdit: () => void
}) {
  return (
    <div className="destination-ribbon">
      <span className="destination-ribbon-icon">
        {mode === 'existing' ? <FolderOpen /> : <FolderPlus />}
      </span>
      <div>
        <small>
          {mode === 'existing' ? 'THƯ MỤC ĐÍCH' : 'THƯ MỤC SẼ TẠO'}
        </small>
        <strong>{name}</strong>
        {source && (
          <span>
            {source.name} · {formatFileSize(source.size)}
          </span>
        )}
      </div>
      <button type="button" onClick={onEdit}>
        Thay đổi
      </button>
    </div>
  )
}

function ColumnSelect({
  label,
  value,
  headers,
  disabledColumn,
  onChange,
}: {
  label: string
  value: number
  headers: string[]
  disabledColumn: number
  onChange: (value: number) => void
}) {
  return (
    <label
      className="column-select"
      data-testid={
        label === 'Mặt tiếng Anh' ? 'english-column' : 'vietnamese-column'
      }
    >
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {headers.map((header, index) => (
          <option value={index} disabled={index === disabledColumn} key={index}>
            {header || `Cột ${String.fromCharCode(65 + index)}`}
          </option>
        ))}
      </select>
    </label>
  )
}

function ErrorMessage({
  message,
  onClose,
}: {
  message: string
  onClose: () => void
}) {
  if (!message) return null
  return (
    <div className="error-message" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onClose} aria-label="Đóng thông báo lỗi">
        <X />
      </button>
    </div>
  )
}
