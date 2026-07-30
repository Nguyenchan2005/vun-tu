const FIREBASE_AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-credential':
    'Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.',
  'auth/invalid-email': 'Địa chỉ email không hợp lệ.',
  'auth/missing-password': 'Vui lòng nhập mật khẩu.',
  'auth/network-request-failed':
    'Không thể kết nối Firebase. Vui lòng kiểm tra mạng.',
  'auth/too-many-requests':
    'Bạn đã thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.',
  'auth/user-disabled': 'Tài khoản này đã bị vô hiệu hóa.',
  'auth/user-not-found':
    'Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.',
  'auth/wrong-password':
    'Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.',
}

export function firebaseAuthErrorMessage(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : ''
  return (
    FIREBASE_AUTH_ERROR_MESSAGES[code] ??
    'Không thể xác thực tài khoản. Vui lòng thử lại.'
  )
}
