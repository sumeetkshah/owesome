import { useEffect, useState } from 'react'

export type Route = { name: 'home' } | { name: 'new' } | { name: 'group'; code: string }

function parse(path: string): Route {
  const m = path.match(/^\/g\/([a-z0-9]+)\/?$/i)
  if (m) return { name: 'group', code: m[1].toLowerCase() }
  if (path === '/new') return { name: 'new' }
  return { name: 'home' }
}

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo(0, 0)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname))
  useEffect(() => {
    const onPop = () => setRoute(parse(location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return route
}

export const inviteUrl = (code: string) => `${location.origin}/g/${code}`
