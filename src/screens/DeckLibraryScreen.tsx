import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Bell,
  BookOpen,
  FileText,
  Layers3,
  Search,
  Upload,
} from 'lucide-react'

import type { DeckSummary, StudyDirection } from '../models'

interface DeckLibraryScreenProps {
  decks: DeckSummary[]
  onStartStudy: (deckId: string) => void
  onImport: () => void
  onChangeDirection: (
    deckId: string,
    direction: StudyDirection,
  ) => Promise<void>
}

export function DeckLibraryScreen({
  decks,
  onStartStudy,
  onImport,
  onChangeDirection,
}: DeckLibraryScreenProps) {
  const [query, setQuery] = useState('')
  const filteredDecks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('vi')
    if (!normalized) return decks
    return decks.filter((deck) =>
      deck.name.toLocaleLowerCase('vi').includes(normalized),
    )
  }, [decks, query])

  return (
    <section className="page library-page" data-testid="deck-library">
      <div className="page-heading library-heading">
        <div>
          <p className="eyebrow">THƯ VIỆN CỦA BẠN</p>
          <h1>Mỗi bộ từ, một chặng nhớ.</h1>
          <p>
            Chọn một bộ để ôn hoặc đổi hướng học phù hợp với mục tiêu hôm nay.
          </p>
        </div>
        <button className="button button-primary" type="button" onClick={onImport}>
          <Upload />
          Nhập bộ từ
        </button>
      </div>

      <div className="library-toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Tìm bộ từ</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Tìm trong các bộ từ…"
          />
        </label>
        <span className="library-total">
          <strong>{filteredDecks.length}</strong>
          {query ? ` kết quả trong ${decks.length} bộ` : ' bộ từ đã lưu'}
        </span>
      </div>

      {filteredDecks.length > 0 ? (
        <div className="library-grid">
          {filteredDecks.map((deck, index) => (
            <article
              className={`library-card accent-${(index % 4) + 1}`}
              key={deck.id}
            >
              <div className="library-card-top">
                <div className="library-card-origin">
                  <span className="deck-number">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="library-source">
                    {deck.sourceType === 'manual'
                      ? 'THỦ CÔNG'
                      : deck.sourceType.toUpperCase()}
                  </span>
                </div>
                {deck.reminderEnabled && (
                  <span className="deck-reminder" title="Đang bật nhắc học">
                    <Bell />
                  </span>
                )}
              </div>
              <div className="deck-card-title">
                <Layers3 />
                <h2>{deck.name}</h2>
              </div>
              <p
                className="deck-description deck-source-line"
                title={deck.sourceName}
              >
                <FileText aria-hidden="true" />
                <span>Nguồn file</span>
                <strong>{deck.sourceName ?? 'Nguồn nhập thủ công'}</strong>
              </p>
              <div className="deck-count-line">
                <span>
                  <strong>{deck.cardCount}</strong> thẻ
                </span>
                <span>
                  <strong>{deck.dueCount}</strong> đến hạn
                </span>
                <span>
                  <strong>{deck.newCount}</strong> thẻ mới
                </span>
              </div>

              <label className="direction-field">
                <span>Hướng học mặc định</span>
                <select
                  value={deck.preferredDirection}
                  onChange={(event) =>
                    void onChangeDirection(
                      deck.id,
                      event.target.value as StudyDirection,
                    )
                  }
                >
                  <option value="en-vi">Anh → Việt</option>
                  <option value="vi-en">Việt → Anh</option>
                  <option value="random">Ngẫu nhiên</option>
                </select>
              </label>

              <button
                className="deck-study-link"
                type="button"
                onClick={() => onStartStudy(deck.id)}
              >
                <BookOpen />
                {deck.dueCount > 0
                  ? `Ôn ${deck.dueCount} thẻ`
                  : 'Học bộ từ này'}
                <ArrowRight />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-search paper-panel">
          <BookOpen />
          <h2>
            {decks.length > 0
              ? 'Không tìm thấy bộ từ phù hợp.'
              : 'Thư viện đang chờ tệp đầu tiên.'}
          </h2>
          <p>
            {decks.length > 0
              ? 'Thử một từ khóa khác hoặc nhập thêm danh sách mới.'
              : 'Nhập một danh sách để tạo bộ thẻ đầu tiên của bạn.'}
          </p>
          {decks.length === 0 && (
            <button
              className="button button-primary"
              type="button"
              onClick={onImport}
            >
              <Upload />
              Chọn tệp để nhập
            </button>
          )}
        </div>
      )}
    </section>
  )
}
