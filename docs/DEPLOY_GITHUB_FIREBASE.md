# Triển khai Vun Từ với GitHub Pages và Firebase

Tài liệu này hướng dẫn từ một tài khoản Firebase/GitHub mới đến khi Vun Từ chạy
như web app trên iPhone. App được build thành site tĩnh trên GitHub Pages; đăng
nhập và đồng bộ dùng Firebase Authentication + Cloud Firestore.

## Dữ liệu được lưu ở đâu

| Thành phần | Nơi lưu | Có dùng chung mọi thiết bị? |
| --- | --- | --- |
| Mã và giao diện app | GitHub repository + GitHub Pages | Có, đây là cùng một phiên bản app |
| Bộ từ, thẻ, tiến độ, lịch sử, cài đặt | Cloud Firestore dưới UID của bạn | Có, tự kéo/đẩy sau khi đăng nhập |
| Hàng đợi và bản làm việc offline | IndexedDB trên từng thiết bị | Không trực tiếp; tự ghép vào Firestore khi có mạng |
| File gốc DOCX/XLSX/TXT/CSV | Thư mục của bạn trong iCloud Drive | Có qua ứng dụng Files, nhưng app không tự tải file gốc lên Firebase |
| Bản dự phòng JSON do app xuất | Nơi bạn chọn trong iCloud Drive | Có, dùng để khôi phục khi cần; file không mã hóa |

GitHub Pages không phải database. “Cùng dữ liệu ở bất cứ đâu” đến từ việc mọi
thiết bị đăng nhập **đúng cùng một Firebase user**, không phải từ GitHub hay
iCloud. IndexedDB giúp tiếp tục học offline; durable outbox giữ các thay đổi
chưa gửi. Khi mạng trở lại, app tự retry và Firestore phân phối thay đổi sang
thiết bị khác.

Bản dự phòng JSON là văn bản thuần, chứa bộ từ, tiến độ, lịch sử học và cài đặt.
Chỉ lưu trong iCloud Drive cá nhân, không gửi vào chat/email công cộng và không
chia sẻ link. IndexedDB/cache trên từng trình duyệt cũng chỉ là lưu trữ
best-effort: app có yêu cầu persistent storage khi browser hỗ trợ, nhưng cloud
đã đồng bộ và bản JSON vẫn là hai lớp bảo vệ cần thiết.

Nên hoàn tất Firebase + Rules + GitHub Secrets trước khi nhập dữ liệu thật. Nếu
đã có dữ liệu local từ phiên bản cũ, lần đăng nhập Firebase đầu tiên sẽ nhận
tài khoản đó làm chủ bộ dữ liệu local và tải những entity còn thiếu lên cloud.
Không đăng nhập một tài khoản Firebase khác trên cùng browser profile; app sẽ
chặn để tránh đưa dữ liệu của tài khoản đầu sang tài khoản thứ hai.

### Giới hạn miễn phí khi có rất nhiều file

Cloud Firestore hiện cho một database miễn phí mỗi project với 1 GiB dữ liệu,
50.000 document reads/ngày, 20.000 writes/ngày, 20.000 deletes/ngày và 10 GiB
outbound/tháng. Quota ngày reset quanh nửa đêm giờ Pacific; xem bảng hiện hành
tại [Cloud Firestore pricing](https://firebase.google.com/docs/firestore/pricing).

- Lần đầu một thiết bị mới đăng nhập phải đọc toàn bộ dữ liệu của tài khoản.
  Các lần sau app dùng cursor riêng cho deck/card/log/settings và chỉ đọc phần
  thay đổi.
- Nhập N thẻ cần xấp xỉ N + 1 writes. Một lượt học cập nhật card, thêm study log
  và cập nhật deck, nên có thể cần 3 writes.
- Xóa dùng tombstone để thiết bị offline lâu ngày không làm sống lại dữ liệu;
  tombstone và study log vì vậy làm storage/lần tải thiết bị mới tăng dần.
- Nếu chạm quota, thay đổi vẫn nằm trong outbox IndexedDB. Không xóa Website
  Data/app; chờ quota reset rồi bấm **Đồng bộ ngay**.
- Một thẻ hoặc bộ từ được giới hạn bảo thủ ở 900 KiB sau khi mã hóa. Nếu một
  dòng nhập quá lớn, app từ chối toàn bộ lượt nhập **trước khi lưu local**, nêu
  `sourceRow` cần rút gọn và không tạo hàng đợi bị kẹt.
- Với hàng chục nghìn thẻ/log, nên nhập theo đợt, xác nhận số chờ về 0 và thử
  thiết bị thứ hai trước khi xóa bất kỳ bản local nào.

Quan trọng: bootstrap đầu trên thiết bị mới hiện chưa phân trang/resume từng
page. Nếu tổng số card + deck + study log + tombstone tiến gần hoặc vượt 50.000
documents, một lần bootstrap ở Spark có thể hết quota reads trước khi hoàn tất
và hôm sau phải đọc lại. Trước ngưỡng này cần dọn/compact log và tombstone bằng
một quy trình quản trị đã kiểm tra, nâng Blaze, hoặc nâng cấp sync sang
pagination + cursor theo page. Không xóa tombstone thủ công khi còn thiết bị lâu
ngày chưa online vì dữ liệu cũ có thể bị tạo lại.

App cố ý không dùng Cloud Storage for Firebase cho file gốc. Từ ngày 03-02-2026,
Cloud Storage yêu cầu project ở gói Blaze dù vẫn có mức sử dụng không tính phí;
xem [Firebase Storage billing FAQ](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024).
Giữ file DOCX/XLSX/TXT gốc trong iCloud Drive giúp dự án này tiếp tục ở Spark
không cần thẻ thanh toán.

## 1. Trước khi bắt đầu

Cần chuẩn bị:

- Một tài khoản Google để quản lý Firebase.
- Một tài khoản GitHub.
- Node.js 24 và npm nếu muốn chạy thử trên máy.
- Email và mật khẩu dành cho tài khoản đăng nhập Vun Từ.

Không đưa các thông tin sau vào repository hoặc biến `VITE_*`:

- Firebase service-account JSON.
- Private key, Admin SDK key hoặc refresh token.
- Mật khẩu người dùng.

Firebase Web config là thông tin định danh phía client, không phải khóa quản trị.
An toàn dữ liệu phải dựa vào Authentication và Firestore Security Rules. Tuy vậy,
workflow này vẫn nhận Web config qua GitHub Actions secrets để không phải ghi các
giá trị riêng của dự án trực tiếp vào mã nguồn.

## 2. Tạo Firebase project và Web App

1. Mở [Firebase Console](https://console.firebase.google.com/) và đăng nhập.
2. Chọn **Create a project**.
3. Nhập tên hiển thị, ví dụ `Vun Tu`.
4. Kiểm tra **Project ID**. ID phải duy nhất và không thể đổi sau khi tạo.
5. Google Analytics không bắt buộc cho app này; có thể tắt để cấu hình gọn hơn.
6. Chọn **Create project**, chờ hoàn tất rồi chọn **Continue**.
7. Tại trang **Project Overview**, bấm biểu tượng Web `</>`.
8. Đặt App nickname, ví dụ `Vun Tu Web`.
9. Không cần bật Firebase Hosting vì frontend sẽ đặt trên GitHub Pages.
10. Bấm **Register app**.
11. Sao chép object `firebaseConfig` Firebase hiển thị và lưu tạm ở nơi an toàn.

Firebase cho phép lấy lại config sau này tại:
**Project settings → General → Your apps → SDK setup and configuration → Config**.
Các bước đăng ký Web App và lấy config được mô tả trong
[tài liệu Firebase Web chính thức](https://firebase.google.com/docs/web/setup).

Config thường có dạng:

```js
const firebaseConfig = {
  apiKey: "…",
  authDomain: "PROJECT_ID.firebaseapp.com",
  projectId: "PROJECT_ID",
  storageBucket: "PROJECT_ID.firebasestorage.app",
  messagingSenderId: "…",
  appId: "…"
}
```

### Chạy local bằng `.env.local`

Tạo file `.env.local` tại thư mục gốc của dự án:

```dotenv
VITE_FIREBASE_API_KEY=giá_trị_apiKey
VITE_FIREBASE_AUTH_DOMAIN=giá_trị_authDomain
VITE_FIREBASE_PROJECT_ID=giá_trị_projectId
VITE_FIREBASE_APP_ID=giá_trị_appId
VITE_FIREBASE_STORAGE_BUCKET=giá_trị_storageBucket
VITE_FIREBASE_MESSAGING_SENDER_ID=giá_trị_messagingSenderId
```

`storageBucket` và `messagingSenderId` là tùy chọn trong app, nhưng nên điền đúng
nếu config Firebase cung cấp. Bốn biến `API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID` và
`APP_ID` là bắt buộc.

Repository đã ignore `*.local`, vì vậy `.env.local` không được commit. Kiểm tra:

```powershell
npm.cmd install
npm.cmd run dev
```

Trên macOS/Linux dùng `npm install` và `npm run dev`.

## 3. Bật đăng nhập Email/Password và tạo một người dùng

1. Trong Firebase Console, mở **Build → Authentication**.
2. Bấm **Get started** nếu đây là lần đầu mở Authentication.
3. Mở tab **Sign-in method**.
4. Chọn provider **Email/Password**.
5. Bật **Email/Password**; không cần bật **Email link (passwordless sign-in)**.
6. Bấm **Save**.
7. Mở tab **Users**.
8. Bấm **Add user**.
9. Nhập email đăng nhập và một mật khẩu mạnh, sau đó xác nhận tạo.
10. Sao chép và lưu lại **User UID**. UID này sẽ được điền vào Security Rules
    để chỉ đúng một tài khoản được phép dùng database.

Không lưu mật khẩu vào GitHub Secrets: app yêu cầu người dùng nhập mật khẩu lúc
đăng nhập. Firebase hỗ trợ tạo user trực tiếp ở tab Users; xem
[quản lý Firebase users](https://firebase.google.com/docs/auth/web/manage-users).
Hướng dẫn bật provider và chính sách mật khẩu nằm tại
[Password Authentication](https://firebase.google.com/docs/auth/web/password-auth).

Khuyến nghị thêm:

- Vào **Authentication → Settings → Password policy** và yêu cầu mật khẩu đủ dài,
  có chữ hoa, chữ thường, số và ký tự đặc biệt.
- Vào **Authentication → Settings → User actions**, giữ bật **Email enumeration
  protection**. Project mới thường đã bật mặc định; tính năng này làm lỗi email
  không tồn tại và mật khẩu sai khó phân biệt hơn; xem
  [Email enumeration protection](https://docs.cloud.google.com/identity-platform/docs/admin/email-enumeration-protection).
- Không thêm giao diện tự đăng ký nếu app chỉ dành cho một người dùng.
- Khi cần thu hồi quyền, disable hoặc delete user ở tab **Users**.

## 4. Tạo Cloud Firestore ở Production mode

1. Trong Firebase Console, mở **Build → Firestore Database**.
2. Bấm **Create database**.
3. Chọn database mặc định và **Standard edition** nếu Console hỏi edition.
4. Chọn **Production mode**. Chế độ này deny read/write ban đầu, an toàn hơn Test
   mode.
5. Chọn location gần người dùng chính để giảm độ trễ.
6. Kiểm tra kỹ trước khi xác nhận: location của database không thể đổi sau khi
   tạo.
7. Bấm **Create/Enable** và chờ database sẵn sàng.

Không cần tạo collection thủ công; Firestore tạo collection/document khi app ghi
dữ liệu hợp lệ lần đầu. Firebase khuyến nghị bảo vệ Web SDK bằng Authentication
và Rules; xem [Firestore quickstart](https://firebase.google.com/docs/firestore/quickstart).

### Deploy Security Rules trước lần đồng bộ đầu tiên

Root của repository sẽ chứa file Rules và cấu hình Firebase tương ứng, thường là:

- `firestore.rules`
- `firebase.json`
- `.firebaserc` hoặc project alias local

File `firestore.rules` cố ý chứa placeholder an toàn:

```text
REPLACE_WITH_YOUR_FIREBASE_AUTH_UID
```

Trước khi deploy:

1. Mở `firestore.rules` bằng Notepad hoặc VS Code.
2. Thay đúng chuỗi placeholder trên bằng User UID đã sao chép ở mục 3; giữ
   nguyên hai dấu nháy kép.
3. Lưu file.
4. Chạy lệnh kiểm tra dưới đây. Nếu không có output là đã thay hết:

```powershell
Select-String -Path .\firestore.rules -Pattern "REPLACE_WITH_YOUR_FIREBASE_AUTH_UID"
```

UID Firebase là mã định danh, không phải mật khẩu/private key. Việc khóa Rules
theo UID ngăn một người khác tự tạo tài khoản qua API rồi dùng quota Firestore
của dự án. Không dùng rule `allow read, write: if true` trong production.

Sau đó triển khai bằng Firebase CLI:

```powershell
npx.cmd firebase-tools login
npx.cmd firebase-tools use --add YOUR_FIREBASE_PROJECT_ID
npx.cmd firebase-tools deploy --only firestore:rules
```

Trên macOS/Linux bỏ `.cmd`:

```bash
npx firebase-tools login
npx firebase-tools use --add YOUR_FIREBASE_PROJECT_ID
npx firebase-tools deploy --only firestore:rules
```

Ở lệnh `use --add`, chọn đúng project vừa tạo và đặt alias, ví dụ `production`.
Sau deploy, mở **Firestore Database → Rules** và kiểm tra:

- Rules đang ở version mong muốn.
- Người chưa đăng nhập bị từ chối.
- Người dùng chỉ truy cập được dữ liệu thuộc UID của mình.

Có thể dùng Rules Playground trong tab Rules trước khi publish. Firebase mô tả
cách test và deploy tại
[Get started with Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started).

## 5. Thêm authorized domains

GitHub Pages project site có URL dạng:

```text
https://USERNAME.github.io/REPOSITORY/
```

Domain cần thêm vào Firebase chỉ là hostname, không có protocol hoặc path:

```text
USERNAME.github.io
```

Thao tác:

1. Mở **Authentication → Settings**.
2. Tìm **Authorized domains**.
3. Bấm **Add domain**.
4. Nhập chính xác `USERNAME.github.io`.
5. Nếu dùng custom domain, thêm custom hostname đó.
6. Nếu test local, thêm `localhost` thủ công khi chưa có.

Không nhập `https://`, dấu `/`, tên repository hoặc wildcard. Cả user-site và
project-site trên cùng tài khoản đều dùng hostname `USERNAME.github.io`. Firebase
hướng dẫn vị trí thiết lập tại
[Authorized domains](https://firebase.google.com/docs/auth/web/firebaseui#oauth_providers_google_facebook_twitter_and_github).

## 6. Tạo GitHub repository

### Repository mới

1. Trên GitHub, bấm **New repository**.
2. Chọn một trong hai kiểu:
   - `USERNAME.github.io`: site người dùng, URL ở root `/`.
   - Tên project như `vun-tu`: site project, URL ở `/vun-tu/`.
3. Chọn public, hoặc private nếu gói GitHub của bạn hỗ trợ Pages cho private repo.
4. Không tạo README/.gitignore mới nếu thư mục local đã có các file này.
5. Bấm **Create repository**.

Trong thư mục dự án local:

```powershell
git config user.name "TEN_HIEN_THI_GITHUB_CUA_BAN"
git config user.email "EMAIL_GITHUB_HOAC_EMAIL_NOREPLY_CUA_BAN"
git add .
git commit -m "Prepare Vun Tu for deployment"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

Thư mục bàn giao đã được `git init` sẵn trên branch `main`, nhưng chưa commit vì
tên/email tác giả phải là của bạn. Có thể lấy email riêng tư tại
**GitHub → Settings → Emails → Keep my email addresses private**. Nếu repository
đã có remote, không chạy lại `remote add`; chỉ commit và push thay đổi.

`vite.config.ts` tự đọc biến chuẩn `GITHUB_REPOSITORY=owner/repository` trong
GitHub Actions:

- Repo `owner.github.io` được build với base `/`.
- Repo project được build với base `/repository/`.
- Local development mặc định dùng `/`.

Không cần sửa base thủ công khi đổi tên repository; push lại để workflow build với
tên mới.

## 7. Tạo GitHub Actions secrets

Từ object `firebaseConfig`, tạo sáu repository secrets:

| GitHub secret | Giá trị Firebase config | Bắt buộc |
| --- | --- | --- |
| `VITE_FIREBASE_API_KEY` | `apiKey` | Có |
| `VITE_FIREBASE_AUTH_DOMAIN` | `authDomain` | Có |
| `VITE_FIREBASE_PROJECT_ID` | `projectId` | Có |
| `VITE_FIREBASE_APP_ID` | `appId` | Có |
| `VITE_FIREBASE_STORAGE_BUCKET` | `storageBucket` | Không |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` | Không |

Với từng secret:

1. Mở repository GitHub.
2. Chọn **Settings → Secrets and variables → Actions**.
3. Chọn tab **Secrets**.
4. Bấm **New repository secret**.
5. Nhập tên chính xác, viết hoa và có prefix `VITE_FIREBASE_`.
6. Dán giá trị tương ứng, không thêm dấu nháy.
7. Bấm **Add secret**.

GitHub không cho đọc lại plaintext sau khi lưu. Nếu sai, mở secret và chọn update.
Workflow kiểm tra bốn biến bắt buộc; secret thiếu sẽ tạo error rõ ràng thay vì
deploy một bản không thể đăng nhập. Quy trình tạo repository secret chính thức:
[Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets?tool=webui).

Workflow cũng cố ý dừng nếu `firestore.rules` còn placeholder UID. Đây là chốt
an toàn để bản cloud chưa khóa đúng chủ sở hữu không được deploy nhầm.

## 8. Bật và deploy GitHub Pages

Repository đã có workflow `.github/workflows/deploy-pages.yml`. Workflow:

1. Checkout source.
2. Dùng Node.js 24.
3. Chạy `npm ci` từ lockfile.
4. Kiểm tra Firebase config bắt buộc.
5. Chạy lint và unit tests.
6. Build với base GitHub Pages đúng loại repository.
7. Upload riêng thư mục `dist`.
8. Deploy artifact qua environment `github-pages`.

Thiết lập Pages:

1. Mở **Settings → Pages** trong repository.
2. Ở **Build and deployment → Source**, chọn **GitHub Actions**.
3. Mở tab **Actions** và chọn workflow **Deploy Vun Từ to GitHub Pages**.
4. Chọn **Run workflow** để chạy tay, hoặc push một commit lên `main`.
5. Chờ cả job **Verify and build** và **Deploy** có dấu xanh.
6. Mở URL trong output của job Deploy hoặc tại **Settings → Pages**.

Workflow dùng các action được GitHub khuyến nghị cho custom Pages workflow:
`configure-pages`, `upload-pages-artifact` và `deploy-pages`; xem
[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Mọi push lên `main` hoặc `master` đều có thể kích hoạt deploy. Concurrency sẽ hủy
deploy cũ đang chạy nếu có commit mới, tránh bản cũ ghi đè bản mới.

### Kiểm tra sau deploy

Mở DevTools của trình duyệt desktop:

1. Tab **Application → Manifest**:
   - Name là `Vun Từ`.
   - `start_url` và `scope` nằm đúng dưới URL repository.
   - Icon 192, 512 và maskable không báo lỗi.
2. Tab **Application → Service Workers**:
   - `sw.js` có status activated/running.
   - Scope khớp `/` hoặc `/REPOSITORY/`.
3. Tab **Cache Storage**:
   - Có cache bắt đầu bằng `vun-tu-app-shell-v4-`.
   - Có `index.html`, JS/CSS build và offline page.
   - `asset-manifest.json` giúp cache cả màn hình Nhập lazy và parser DOCX.
4. Bật **Offline** trong Network, reload app và thử mở dashboard/bộ thẻ.
5. Tắt Offline, đăng nhập và xác nhận đồng bộ trở lại.

Service worker chỉ cache request GET cùng origin và nằm trong app scope. Request
Firebase bên ngoài origin không bị cache bởi service worker này.

### Xác nhận hai thiết bị thật sự dùng cùng dữ liệu

Thực hiện đúng thứ tự, không mở đồng thời quá nhiều tab trong lần đầu:

1. Trên máy tính, mở site, đăng nhập đúng email đã tạo trong Firebase.
2. Nếu browser đang có dữ liệu cũ, giữ trang mở và vào **Cài đặt → Đồng bộ &
   sao lưu**.
3. Chờ trạng thái thành **Dữ liệu đã đồng bộ** và số thay đổi chờ bằng 0.
4. Mở **Firestore Database → Data → users → YOUR_UID**. Phải thấy các
   collection `decks`, `cards`, `studyLogs` và `settings` khi tương ứng có dữ
   liệu.
5. Trên iPhone, mở cùng URL bằng Safari và đăng nhập **cùng email**.
6. Chờ đồng bộ lần đầu; bộ từ trên máy tính phải xuất hiện trên iPhone.
7. Trên iPhone, tạo/nhập một bộ nhỏ hoặc học một thẻ; chờ trạng thái đã đồng bộ.
8. Quay lại máy tính. Không cần reload trong điều kiện bình thường; thay đổi
   phải xuất hiện qua realtime listener. Nếu tab đã bị hệ điều hành ngủ, mở lại
   tab để incremental sync chạy.
9. Kiểm tra offline: bật Airplane Mode trên iPhone, học thêm một thẻ, rồi tắt
   Airplane Mode. Trạng thái chờ phải trở về 0 và tiến độ mới xuất hiện trên máy
   tính.

Chỉ xóa dữ liệu local/browser sau khi đã thấy dữ liệu trên thiết bị thứ hai và
đã lưu thêm một bản dự phòng JSON vào iCloud Drive. Trước khi xóa Safari
Website Data, bắt buộc chờ số thay đổi chờ về 0; xóa Website Data cũng xóa
IndexedDB/outbox chưa kịp gửi.

### Quy tắc an toàn khi chuyển thiết bị

- Trước khi rời một thiết bị, mở app khi có mạng và chờ số thay đổi chờ về 0.
- Chỉ dùng **một tab đang thao tác chính** cho mỗi thiết bị. Không nhập file,
  đổi cài đặt, sửa/xóa cùng một bộ hoặc học **cùng một thẻ** trên hai thiết bị
  đang offline. Mỗi document được đồng bộ nguyên khối; thay đổi còn chờ ở thiết
  bị reconnect sau có thể thắng thay đổi mới hơn ở thiết bị kia. Vì vậy một
  thao tác sửa cũ có thể ghi đè dữ liệu, một upsert cũ có thể làm sống lại mục
  vừa xóa, và nhập cùng file vào cùng bộ trên hai máy có thể tạo thẻ trùng.
- Trước khi đổi máy, đóng tab cũ hoặc ngừng thao tác trên tab đó sau khi số thay
  đổi chờ đã về 0. Không để hai tab cùng nhập/học song song chỉ vì chúng cùng
  đăng nhập một tài khoản.
- Có thể học các thẻ/bộ khác nhau offline; khi online lại, theo dõi trạng thái
  đồng bộ trước khi tiếp tục ở thiết bị còn lại.
- Cách giải quyết xung đột tuyệt đối trong một bản nâng cấp tương lai là tính
  lại card aggregate từ immutable study logs hoặc dùng server-side
  transaction/version check. Bản hiện tại ưu tiên thay đổi local đang chờ để
  không làm mất thao tác offline.

## 9. Cài Vun Từ trên iPhone

GitHub Pages phục vụ HTTPS nên đủ điều kiện chạy PWA.

1. Kết nối mạng và mở URL đã deploy bằng **Safari** trên iPhone.
2. Chờ app tải xong; nên mở dashboard và một bộ thẻ ít nhất một lần để app shell
   và dữ liệu local được lưu.
3. Chạm nút **Share/Chia sẻ** trong Safari.
4. Cuộn xuống và chọn **Add to Home Screen/Thêm vào Màn hình chính**.
5. Bật **Open as Web App/Mở dưới dạng ứng dụng web** nếu iOS hiển thị lựa chọn.
6. Giữ tên `Vun Từ`, sau đó chạm **Add/Thêm**.
7. Mở icon Vun Từ từ Home Screen. App sẽ chạy standalone, không có thanh địa chỉ.

Đây là đúng luồng Apple công bố tại
[Turn a website into an app in Safari on iPhone](https://support.apple.com/en-lb/guide/iphone/iphea86e5236/ios).

### Kiểm tra offline trên iPhone

1. Mở app khi online ít nhất một lần.
2. Đóng app.
3. Bật Airplane Mode.
4. Mở lại từ icon Home Screen.
5. App shell và dữ liệu IndexedDB đã có trên thiết bị phải mở được.
6. Tắt Airplane Mode để đăng nhập/đồng bộ thay đổi cloud.

Nếu lần đầu truy cập đã mất mạng, trang “Bạn đang ngoại tuyến” sẽ hướng dẫn kết
nối lại.

### Nhận bản cập nhật

Mỗi lần mở app khi online, trình duyệt kiểm tra `sw.js`. Worker mới chờ các
client của bản cũ đóng trước khi kích hoạt, để không reload giữa lúc đang nhập
file hoặc trả lời flashcard. App shell mới sẽ thay cache cũ ở lần mở an toàn
tiếp theo. Nếu iPhone vẫn giữ bản quá cũ:

1. Đóng mọi tab/site Vun Từ và web app, rồi mở lại khi online.
2. Nếu chưa được, xóa icon khỏi Home Screen.
3. Vào **Settings → Safari → Advanced → Website Data**, xóa data của
   `USERNAME.github.io`.
4. Mở URL trong Safari và Add to Home Screen lại.

## 10. Checklist bảo mật trước khi dùng thật

- [ ] Firestore đang ở Production mode.
- [ ] `firestore.rules` đã thay placeholder bằng đúng UID duy nhất.
- [ ] Rules đã deploy và không có `allow ... if true`.
- [ ] Người chưa đăng nhập không đọc/ghi được dữ liệu.
- [ ] User A không truy cập document của User B.
- [ ] Chỉ Email/Password hoặc provider thực sự dùng mới được bật.
- [ ] Authorized domains chỉ gồm localhost, Firebase domains, GitHub Pages/custom
      domain đang dùng.
- [ ] Không có service-account JSON/private key trong git history.
- [ ] Không có mật khẩu trong source, `.env*`, workflow hoặc GitHub Secrets.
- [ ] GitHub branch và environment protection phù hợp.
- [ ] Đã bật budget alerts/quota monitoring nếu nâng Firebase lên Blaze.

## 11. Xử lý lỗi thường gặp

### Workflow báo thiếu repository secret

Tên secret phải khớp tuyệt đối bảng ở mục 7. Secret tạo sau một workflow run không
tự áp dụng cho run cũ; chọn **Re-run all jobs**.

### Site mở nhưng JS/CSS 404

Kiểm tra workflow build có biến `GITHUB_REPOSITORY`. Không hard-code `base: '/'`
cho project site. Xóa build artifact cũ bằng cách push/re-run workflow hiện tại.

### `auth/unauthorized-domain`

Thêm đúng hostname `USERNAME.github.io` tại Authentication Authorized domains.
Không thêm repository path.

### Đăng nhập được nhưng Firestore báo `permission-denied`

1. Xác nhận đang dùng đúng Firebase project trong GitHub Secrets.
2. Kiểm tra user chưa bị disable.
3. Kiểm tra Rules đã deploy vào đúng project.
4. So sánh `request.auth.uid` với UID/đường dẫn document mà Rules yêu cầu.
5. Dùng Rules Playground để mô phỏng request authenticated.

### Không thấy Add to Home Screen

- Dùng Safari thay vì trình duyệt in-app.
- Mở URL HTTPS đã deploy, không dùng preview HTTP local.
- Thoát Private Browsing.
- Trong Share sheet, chọn **Edit Actions/Sửa tác vụ** nếu mục bị ẩn.
- Kiểm tra manifest và icon bằng DevTools desktop.

### Offline page xuất hiện dù đã mở app trước đó

Đảm bảo service worker đã được đăng ký với đúng `import.meta.env.BASE_URL`. Với
project site, scope phải là `/REPOSITORY/`, không phải `/`. Sau khi sửa registration,
xóa Site Data/service worker cũ và truy cập lại khi online.

## 12. Kiểm tra service worker registration

Registration đã được tích hợp sẵn trong `src/main.tsx`; bạn không cần chép hoặc
thêm lại. Đoạn dưới đây chỉ để đối chiếu nếu sau này sửa entrypoint:

```ts
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const entryFile = new URL(import.meta.url).pathname.split('/').at(-1)
    const parameters = new URLSearchParams({
      app: entryFile || 'app',
      sw: import.meta.env.VITE_SW_BUILD_ID,
    })
    const workerUrl =
      `${import.meta.env.BASE_URL}sw.js?${parameters.toString()}`
    void navigator.serviceWorker
      .register(workerUrl, {
        scope: import.meta.env.BASE_URL,
        updateViaCache: 'none',
      })
      .then((registration) => {
        window.setInterval(() => void registration.update(), 60 * 60 * 1000)
      })
  })
}
```

`import.meta.env.BASE_URL` là bắt buộc để cùng đoạn mã hoạt động cho cả user site
và project site. Hai query `app` và `sw` lấy tên entry đã hash cùng hash nội
dung service worker để mỗi bản build có cache staging riêng, kể cả release chỉ
sửa `public/sw.js`; không bỏ query này hoặc hard-code lại cache version. Chỉ
đăng ký trong production để service worker không giữ asset cũ khi phát triển
local.
