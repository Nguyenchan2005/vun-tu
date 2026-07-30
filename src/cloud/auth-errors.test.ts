import { describe, expect, it } from 'vitest'

import { firebaseAuthErrorMessage } from './auth-errors'

describe('Firebase Auth error messages', () => {
  it('maps common login and network errors to Vietnamese', () => {
    expect(
      firebaseAuthErrorMessage({ code: 'auth/invalid-credential' }),
    ).toContain('Email hoặc mật khẩu')
    expect(
      firebaseAuthErrorMessage({ code: 'auth/network-request-failed' }),
    ).toContain('kiểm tra mạng')
    expect(
      firebaseAuthErrorMessage({ code: 'auth/user-not-found' }),
    ).toBe(
      firebaseAuthErrorMessage({ code: 'auth/wrong-password' }),
    )
  })

  it('does not expose unknown SDK internals', () => {
    expect(
      firebaseAuthErrorMessage({
        code: 'auth/internal-error',
        message: 'sensitive detail',
      }),
    ).toBe('Không thể xác thực tài khoản. Vui lòng thử lại.')
  })
})
