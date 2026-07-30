import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

function githubPagesBase(): string {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) return '/'

  const [owner, repositoryName, ...unexpected] = repository.split('/')
  if (!owner || !repositoryName || unexpected.length > 0) return '/'

  const userSiteName = `${owner}.github.io`
  return repositoryName.toLowerCase() === userSiteName.toLowerCase()
    ? '/'
    : `/${repositoryName}/`
}

function serviceWorkerBuildId(): string {
  return createHash('sha256')
    .update(readFileSync(new URL('./public/sw.js', import.meta.url)))
    .digest('hex')
    .slice(0, 12)
}

// GitHub Actions provides GITHUB_REPOSITORY as "owner/repository". A user site
// lives at "/", while a project site must be built beneath "/repository/".
export default defineConfig({
  base: githubPagesBase(),
  build: {
    // The hand-written service worker uses this to pre-cache lazy import and
    // document-parser chunks, so every app feature remains available offline.
    manifest: 'asset-manifest.json',
  },
  define: {
    'import.meta.env.VITE_SW_BUILD_ID': JSON.stringify(
      serviceWorkerBuildId(),
    ),
  },
  plugins: [react()],
})
