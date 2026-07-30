# Vun Từ

Web app học từ vựng tiếng Anh bằng flashcard và lặp lại ngắt quãng. IndexedDB
giữ bản offline trên từng thiết bị; Firebase Authentication + Cloud Firestore
đồng bộ bộ từ, tiến độ, lịch sử học và cài đặt qua cùng một tài khoản. Frontend
có thể host miễn phí bằng GitHub Pages và cài lên màn hình chính iPhone như PWA.

Nếu chưa có biến `VITE_FIREBASE_*`, app vẫn chạy ở chế độ local để phát triển
và hiển thị cảnh báo rõ rằng dữ liệu chỉ ở thiết bị hiện tại. Bản production
nên luôn được build với Firebase config.

## Chạy ứng dụng

Yêu cầu Node.js 24.

```powershell
npm.cmd install
npm.cmd run dev
```

Mở địa chỉ Vite hiển thị trong terminal (mặc định
`http://127.0.0.1:5173`). Trên Windows cũng có thể nhấp đúp
`CHAY_VUN_TU.bat`.

## Chức năng

- Trước khi nhập, chọn tạo thư mục có tên riêng, dùng tên theo ngày nhập hoặc
  thêm vào thư mục có sẵn.
- Nhập `.xlsx`, `.docx`, `.csv`, `.tsv`, `.txt`, `.md`, `.json`, `.html`,
  `.rtf` hoặc link Google Sheets công khai.
- Tự nhận diện cột tiếng Anh/tiếng Việt từ header và nội dung; luôn có bước
  preview để sửa mapping.
- Giữ tên file gốc làm nguồn của bộ từ, không tự tạo các bộ theo ngữ cảnh;
  có thể gộp vào thư mục cũ và bỏ qua thẻ trùng.
- Học Anh → Việt, Việt → Anh hoặc ngẫu nhiên; có thể đổi theo deck và theo
  từng phiên.
- Flip card 3D, phím Space/Enter để lật và phím 1/2 để tự đánh giá.
- Leitner đơn giản với lịch 1 → 3 → 7 → 14 → 30 → 60 ngày; thẻ quên được đưa
  trở lại sớm nhưng không lặp ngay khi còn thẻ khác.
- Lưu số lần đúng/sai, streak, lần học gần nhất, lịch ôn tiếp theo và log từng
  lượt.
- Nhiều giờ nhắc, bật/tắt toàn cục hoặc theo deck, Web Notifications khi được
  cấp quyền và banner trong app khi không được cấp quyền.
- Giao diện tiếng Việt responsive, có bottom navigation trên mobile và hỗ trợ
  reduced motion.

Lần mở đầu tiên bắt đầu với thư viện trống để người dùng chỉ thấy dữ liệu do
chính mình tải lên.

## Kiến trúc

- `src/lib/parser.ts`: đọc dữ liệu và nhận diện/mapping cột.
- `src/lib/scheduler.ts`: thuật toán Leitner và hàng đợi phiên học.
- `src/db/`: Dexie schema, repository, import transaction, lịch sử học và
  durable sync outbox.
- `src/cloud/`: Firebase Auth, Firestore, đồng bộ hai chiều, tombstone và
  cursor tăng dần riêng cho từng loại dữ liệu.
- `src/lib/backup.ts`: xuất/khôi phục bản dự phòng JSON có thể lưu trong iCloud
  Drive mà không ghi đè dữ liệu local mới hơn.
- `src/lib/reminders.ts`: Web Notifications, polling và banner fallback.
- `src/screens/`: dashboard, thư viện, nhập dữ liệu, học và cài đặt.
- `public/sw.js` + `manifest.webmanifest`: app shell offline và cài PWA.

File gốc DOCX/XLSX/TXT không được tải lên Firestore; người dùng giữ chúng trong
iCloud Drive. Firestore chứa dữ liệu đã nhập để app dùng chung ở mọi nơi.

Hướng dẫn từng bước tạo Firebase, khóa Rules theo đúng một UID, tạo repository,
khai báo GitHub Secrets, deploy Pages và cài iPhone nằm tại
[`docs/DEPLOY_GITHUB_FIREBASE.md`](docs/DEPLOY_GITHUB_FIREBASE.md).

## Kiểm tra

```powershell
npm.cmd run test
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run build
npm.cmd audit --audit-level=high
```

Unit test kiểm tra parser, scheduler, database/outbox, backup, merge cloud,
cursor Firestore và auth errors. E2E dùng Edge cục bộ để kiểm tra luồng chính,
file DOCX/XLSX/TXT thật, giao diện mobile, manifest/service worker và offline.

## Giới hạn thông báo web

Scheduler hoạt động khi trang còn mở; tab nền có cơ chế bắt kịp trong 15 phút.
Nếu trình duyệt bị đóng hoàn toàn, hệ điều hành có thể không chạy lịch web.
Khi mở lại, app vẫn hiển thị banner cho các thẻ đến hạn. Sau khi port bằng
Capacitor, phần này có thể thay bằng local notification native.
