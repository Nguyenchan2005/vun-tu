export function formatVietnameseDate(
  value: number | Date = new Date(),
): string {
  const date = typeof value === 'number' ? new Date(value) : value
  return new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

export function formatShortDate(value: number | Date): string {
  const date = typeof value === 'number' ? new Date(value) : value
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export function makeDatedDeckName(date = new Date()): string {
  const day = date.getDate().toString().padStart(2, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  return `Từ vựng ${day}-${month}-${date.getFullYear()}`
}

export function stripFileExtension(filename: string): string {
  return filename.replace(
    /\.(xlsx|csv|tsv|txt|docx|md|markdown|json|html?|rtf)$/i,
    '',
  )
}
