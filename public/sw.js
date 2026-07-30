const CACHE_PREFIX = 'vun-tu'
const WORKER_URL = new URL(self.location.href)
const APP_BUILD_VERSION =
  WORKER_URL.searchParams.get('app') || 'manual'
const SW_BUILD_VERSION =
  WORKER_URL.searchParams.get('sw') || 'manual'
const CACHE_VERSION = `v4-${`${SW_BUILD_VERSION}-${APP_BUILD_VERSION}`.replace(
  /[^A-Za-z0-9_-]/g,
  '_',
)}`
const APP_SHELL_CACHE = `${CACHE_PREFIX}-app-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`
const MAX_RUNTIME_ENTRIES = 72

function scopeUrl(relativePath = './') {
  return new URL(relativePath, self.registration.scope).toString()
}

const CORE_SHELL = [
  scopeUrl('./'),
  scopeUrl('./index.html'),
  scopeUrl('./asset-manifest.json'),
  scopeUrl('./offline.html'),
  scopeUrl('./manifest.webmanifest'),
  scopeUrl('./favicon.svg'),
  scopeUrl('./icons/apple-touch-icon.png'),
  scopeUrl('./icons/pwa-192x192.png'),
  scopeUrl('./icons/pwa-512x512.png'),
  scopeUrl('./icons/maskable-icon-512x512.png'),
]

function isInsideAppScope(url) {
  const scope = new URL(self.registration.scope)
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
}

function cacheableResponse(response) {
  return response && response.ok && response.type === 'basic'
}

async function discoverBuiltAssets(entryResponse) {
  const html = await entryResponse.clone().text()
  const candidates = new Set()
  const assetPattern = /(?:src|href)=["']([^"'#]+)["']/g

  for (const match of html.matchAll(assetPattern)) {
    try {
      const url = new URL(match[1], self.registration.scope)
      if (
        isInsideAppScope(url) &&
        url.protocol.startsWith('http') &&
        !url.pathname.endsWith('/sw.js')
      ) {
        candidates.add(url.toString())
      }
    } catch {
      // A malformed optional asset must not prevent the shell from installing.
    }
  }

  return [...candidates]
}

async function discoverManifestAssets(required) {
  try {
    const response = await fetch(
      new Request(scopeUrl('./asset-manifest.json'), {
        cache: 'no-cache',
      }),
    )
    if (!cacheableResponse(response)) {
      if (required) {
        throw new Error('Production asset manifest could not be fetched.')
      }
      return []
    }
    const manifest = await response.json()
    const candidates = new Set()

    for (const entry of Object.values(manifest)) {
      if (!entry || typeof entry !== 'object') continue
      const paths = [
        entry.file,
        ...(Array.isArray(entry.css) ? entry.css : []),
        ...(Array.isArray(entry.assets) ? entry.assets : []),
      ]
      for (const path of paths) {
        if (typeof path !== 'string') continue
        const url = new URL(path, self.registration.scope)
        if (isInsideAppScope(url)) candidates.add(url.toString())
      }
    }

    return [...candidates]
  } catch (error) {
    if (required) throw error
    // The Vite dev server has no build manifest; HTML discovery remains enough.
    return []
  }
}

async function putIfCacheable(cache, request, response) {
  if (cacheableResponse(response)) {
    await cache.put(request, response)
  }
}

function hashedAssetFamily(requestUrl) {
  const url = new URL(requestUrl)
  const fileName = url.pathname.split('/').at(-1) || ''
  const match = fileName.match(
    /^(.+?)-[A-Za-z0-9_-]{8,}\.(js|css)$/,
  )
  return match ? `${match[1]}.${match[2]}` : null
}

async function putRuntimeIfCacheable(cache, request, response) {
  if (!cacheableResponse(response)) return
  await cache.put(request, response)

  const family = hashedAssetFamily(
    typeof request === 'string' ? request : request.url,
  )
  const keys = await cache.keys()
  const staleSiblings = family
    ? keys.filter(
        (key) =>
          key.url !== (typeof request === 'string' ? request : request.url) &&
          hashedAssetFamily(key.url) === family,
      )
    : []
  await Promise.all(staleSiblings.map((key) => cache.delete(key)))

  const remaining = await cache.keys()
  const excess = Math.max(0, remaining.length - MAX_RUNTIME_ENTRIES)
  await Promise.all(
    remaining.slice(0, excess).map((key) => cache.delete(key)),
  )
}

async function refreshAppShell(cache, entryResponse, forceReload = false) {
  const htmlAssets = await discoverBuiltAssets(entryResponse)
  const productionEntryUrl = htmlAssets.find((url) =>
    /\/assets\/index-[A-Za-z0-9_-]{8,}\.js(?:$|\?)/.test(url),
  )
  const isProductionShell = Boolean(productionEntryUrl)
  const fetchedAppBuild = productionEntryUrl
    ? new URL(productionEntryUrl).pathname.split('/').at(-1)
    : undefined
  if (
    isProductionShell &&
    APP_BUILD_VERSION !== 'manual' &&
    fetchedAppBuild !== APP_BUILD_VERSION
  ) {
    if (forceReload) {
      throw new Error('Worker and app build versions do not match.')
    }
    // An old worker may control a navigation to a freshly deployed build.
    // Keep its complete cache intact for old tabs; the new main entry will
    // register a worker with a separate app/SW-content-versioned cache.
    return false
  }
  const manifestAssets = await discoverManifestAssets(isProductionShell)
  const discoveredAssets = [...new Set([...htmlAssets, ...manifestAssets])]
  const criticalAssets = discoveredAssets.filter((url) =>
    /\.(?:js|css)(?:$|\?)/.test(url),
  )
  const optionalAssets = [
    ...new Set([
      ...CORE_SHELL.slice(2),
      ...discoveredAssets.filter((url) => !criticalAssets.includes(url)),
    ]),
  ]
  const requestCache = forceReload ? 'reload' : 'no-cache'

  // Stage every executable/style dependency before swapping cached index.html.
  // If the network drops, the old complete shell remains authoritative.
  await Promise.all(
    criticalAssets.map(async (url) => {
      const request = new Request(url, { cache: requestCache })
      const response = await fetch(request)
      if (!cacheableResponse(response)) {
        throw new Error(`Critical app asset could not be cached: ${url}`)
      }
      await cache.put(request, response)
    }),
  )

  await Promise.allSettled(
    optionalAssets.map(async (url) => {
      const request = new Request(url, { cache: requestCache })
      const response = await fetch(request)
      await putIfCacheable(cache, request, response)
    }),
  )

  await Promise.all([
    cache.put(scopeUrl('./'), entryResponse.clone()),
    cache.put(scopeUrl('./index.html'), entryResponse.clone()),
  ])

  const keep = new Set([
    scopeUrl('./'),
    scopeUrl('./index.html'),
    ...criticalAssets,
    ...optionalAssets,
  ])
  const keys = await cache.keys()
  await Promise.all(
    keys
      .filter((request) => !keep.has(request.url))
      .map((request) => cache.delete(request)),
  )
  return true
}

async function installAppShell() {
  const cache = await caches.open(APP_SHELL_CACHE)
  const entryRequest = new Request(scopeUrl('./'), { cache: 'reload' })
  const entryResponse = await fetch(entryRequest)

  if (!cacheableResponse(entryResponse)) {
    throw new Error('App shell entry could not be cached.')
  }

  await refreshAppShell(cache, entryResponse, true)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    installAppShell().catch(async (error) => {
      try {
        const cache = await caches.open(APP_SHELL_CACHE)
        await cache.add(scopeUrl('./offline.html'))
      } catch {
        // Preserve the original staging failure below.
      }
      throw error
    }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && ![APP_SHELL_CACHE, RUNTIME_CACHE].includes(key))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

async function navigationResponse(request) {
  const cache = await caches.open(APP_SHELL_CACHE)

  try {
    const response = await fetch(request)
    if (cacheableResponse(response)) {
      await refreshAppShell(cache, response.clone())
    }
    return response
  } catch {
    return (
      (await cache.match(request, { ignoreVary: true })) ||
      (await cache.match(scopeUrl('./'), { ignoreVary: true })) ||
      (await cache.match(scopeUrl('./index.html'), {
        ignoreVary: true,
      })) ||
      (await cache.match(scopeUrl('./offline.html'), {
        ignoreVary: true,
      }))
    )
  }
}

async function staticAssetResponse(request) {
  const appShell = await caches.open(APP_SHELL_CACHE)
  const cached = await appShell.match(request, { ignoreVary: true })
  if (cached) return cached

  const runtime = await caches.open(RUNTIME_CACHE)
  const runtimeCached = await runtime.match(request, {
    ignoreVary: true,
  })
  if (runtimeCached) return runtimeCached

  const response = await fetch(request)
  await putRuntimeIfCacheable(runtime, request, response.clone())
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE)
  const cached = await cache.match(request, { ignoreVary: true })
  const network = fetch(request)
    .then(async (response) => {
      await putRuntimeIfCacheable(cache, request, response.clone())
      return response
    })
    .catch(() => null)

  return (
    cached ||
    (await network) ||
    (await caches.match(scopeUrl('./offline.html'), {
      ignoreVary: true,
    }))
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (
    request.method !== 'GET' ||
    request.headers.has('range') ||
    !isInsideAppScope(new URL(request.url))
  ) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request))
    return
  }

  if (['script', 'style', 'font', 'image'].includes(request.destination)) {
    event.respondWith(staticAssetResponse(request))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
